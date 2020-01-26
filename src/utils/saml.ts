import { distanceInWordsToNow, isAfter, subDays } from "date-fns";
import { Request as ExpressRequest } from "express";
import { flatten } from "fp-ts/lib/Array";
import { toError } from "fp-ts/lib/Either";
import {
  fromEither,
  fromNullable,
  isNone,
  none,
  Option,
  some
} from "fp-ts/lib/Option";
import { collect, lookup } from "fp-ts/lib/Record";
import { TaskEither, taskify, tryCatch } from "fp-ts/lib/TaskEither";
import produce from "immer";
import * as t from "io-ts";
import { NonEmptyString } from "italia-ts-commons/lib/strings";
import { SamlConfig } from "passport-saml";
// tslint:disable-next-line: no-submodule-imports
import { MultiSamlConfig } from "passport-saml/multiSamlStrategy";
import * as x509 from "x509";
import * as xmlCrypto from "xml-crypto";
import { Builder, parseStringPromise } from "xml2js";
import { DOMParser } from "xmldom";
import { SPID_LEVELS, SPID_URLS, SPID_USER_ATTRIBUTES } from "../config";
import { logger } from "./logger";
import {
  getSpidStrategyOption,
  IServiceProviderConfig,
  ISpidStrategyOptions
} from "./middleware";

export type SamlAttributeT = keyof typeof SPID_USER_ATTRIBUTES;

interface IEntrypointCerts {
  // tslint:disable-next-line: readonly-array
  cert: NonEmptyString[];
  entryPoint?: string;
}

const decodeBase64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

/**
 * Remove prefix and suffix from x509 certificate.
 */
const cleanCert = (cert: string) =>
  cert
    .replace(/-+BEGIN CERTIFICATE-+\r?\n?/, "")
    .replace(/-+END CERTIFICATE-+\r?\n?/, "")
    .replace(/\r\n/g, "\n");

const SAMLResponse = t.type({
  SAMLResponse: t.string
});

/**
 * Extracts the issuer field from the response body.
 */
export const getSamlIssuer = (body: unknown): string => {
  return fromEither(SAMLResponse.decode(body))
    .map(_ => Buffer.from(_.SAMLResponse, "base64").toString("utf8"))
    .mapNullable(_ => new DOMParser().parseFromString(_))
    .mapNullable(_ => _.getElementsByTagName("saml:Issuer").item(0))
    .mapNullable(_ => _.textContent)
    .getOrElse("UNKNOWN");
};

/**
 * Extracts IDP entityID from query parameter (if any).
 *
 * @returns
 *  - the certificates (and entrypoint) for the IDP that matches the provided entityID
 *  - all IDP certificates if no entityID is provided (and no entrypoint)
 *  - none if no IDP matches the provided entityID
 */
const getEntrypointCerts = (
  req: ExpressRequest,
  idps: ISpidStrategyOptions["idp"]
): Option<IEntrypointCerts> => {
  return fromNullable(req)
    .mapNullable(r => r.query)
    .mapNullable(q => q.entityID)
    .chain(entityID =>
      fromNullable(idps[entityID]).map(
        idp =>
          ({
            cert: idp.cert.toArray(),
            entryPoint: idp.entryPoint
          } as IEntrypointCerts)
      )
    )
    .alt(
      // collect all IDP certificates in case no entityID is provided
      some({
        cert: flatten(
          collect(idps, (_, idp) => (idp && idp.cert ? idp.cert.toArray() : []))
        ),
        // TODO: leave entryPoint undefined when this gets fixed
        // @see https://github.com/bergie/passport-saml/issues/415
        entryPoint: ""
      } as IEntrypointCerts)
    );
};

const getAuthnContextValueFromResponse = (response: string): Option<string> => {
  const xmlResponse = new DOMParser().parseFromString(response, "text/xml");
  // ie. <saml2:AuthnContextClassRef>https://www.spid.gov.it/SpidL2</saml2:AuthnContextClassRef>
  const responseAuthLevelEl = xmlResponse.getElementsByTagNameNS(
    "urn:oasis:names:tc:SAML:2.0:assertion",
    "AuthnContextClassRef"
  );
  return responseAuthLevelEl[0] && responseAuthLevelEl[0].textContent
    ? some(responseAuthLevelEl[0].textContent.trim())
    : none;
};

/**
 * Extracts the correct SPID level from response.
 */
const getAuthSalmOptions = (
  req: ExpressRequest,
  decodedResponse?: string
): Option<Partial<SamlConfig>> => {
  return fromNullable(req)
    .mapNullable(r => r.query)
    .mapNullable(q => q.authLevel)
    .chain((authLevel: string) =>
      lookup(authLevel, SPID_LEVELS)
        .map(authnContext => ({
          authnContext,
          forceAuthn: authLevel !== "SpidL1"
        }))
        .orElse(() => {
          logger.error(
            "SPID cannot find a valid authnContext for given authLevel: %s",
            authLevel
          );
          return none;
        })
    )
    .alt(
      fromNullable(decodedResponse)
        .chain(response => getAuthnContextValueFromResponse(response))
        .chain(authnContext =>
          lookup(authnContext, SPID_URLS)
            // check if the parsed value is a valid SPID AuthLevel
            .map(authLevel => {
              return {
                authnContext,
                forceAuthn: authLevel !== "SpidL1"
              };
            })
            .orElse(() => {
              logger.error(
                "SPID cannot find a valid authLevel for given authnContext: %s",
                authnContext
              );
              return none;
            })
        )
    );
};

/**
 * Log SPID response body, entityID / authLevel.
 */
const logSpidResponse = (req: ExpressRequest, decodedResponse?: string) => {
  if (req.method === "POST") {
    logger.debug("SPID raw POST request: %s\n", JSON.stringify(req.body));
  } else if (req.method === "GET") {
    logger.debug(
      "SPID GET request entityID: %s - authLevel: %s\n",
      req.query.entityID,
      req.query.authLevel
    );
  } else {
    logger.debug("SPID request method: %s\n", req.method);
  }
  if (decodedResponse && req.method === "POST") {
    logger.debug("SPID decoded POST request: %s\n", decodedResponse);
  }
};

/**
 * Reads dates information in x509 certificate
 * and logs remaining time to its expiration date.
 *
 * @param samlCert x509 certificate as string
 */
export function logSamlCertExpiration(samlCert: string): void {
  try {
    const out = x509.parseCert(samlCert);
    if (out.notAfter) {
      const timeDiff = distanceInWordsToNow(out.notAfter);
      const warningDate = subDays(new Date(), 60);
      if (isAfter(out.notAfter, warningDate)) {
        logger.info("samlCert expire in %s", timeDiff);
      } else if (isAfter(out.notAfter, new Date())) {
        logger.warn("samlCert expire in %s", timeDiff);
      } else {
        logger.error("samlCert expired from %s", timeDiff);
      }
    } else {
      logger.error("Missing expiration date on saml certificate.");
    }
  } catch (e) {
    logger.error("Error calculating saml cert expiration: %s", e);
  }
}

/**
 * This method extracts the correct IDP metadata
 * from the passport strategy options.
 *
 * It's executed for every SPID login (when passport
 * middleware is configured) and when generating
 * the Service Provider metadata.
 */
export const getSamlOptions: MultiSamlConfig["getSamlOptions"] = (
  req,
  done
) => {
  try {
    // Get decoded response
    const decodedResponse =
      req.body && req.body.SAMLResponse
        ? decodeBase64(req.body.SAMLResponse)
        : undefined;

    logSpidResponse(req, decodedResponse);

    // Get SPID strategy options with IDPs metadata
    const spidStrategyOptions = getSpidStrategyOption(req.app);

    // Get the correct entry within the IDP metadata object
    const maybeEntrypointCerts = getEntrypointCerts(
      req,
      spidStrategyOptions.idp
    );
    if (isNone(maybeEntrypointCerts)) {
      logger.debug(
        `SPID cannot find a valid idp in spidOptions for given entityID: ${req.query.entityID}`
      );
    }
    const entrypointCerts = maybeEntrypointCerts.getOrElse(
      {} as IEntrypointCerts
    );

    // Get authnContext (SPID level) and forceAuthn from request payload
    const maybeAuthOptions = getAuthSalmOptions(req, decodedResponse);
    if (isNone(maybeAuthOptions)) {
      logger.debug(
        "SPID cannot find authnContext in response %s",
        decodedResponse
      );
    }
    const authOptions = maybeAuthOptions.getOrElse({});

    return done(null, {
      ...spidStrategyOptions.sp,
      ...entrypointCerts,
      ...authOptions
    });
  } catch (e) {
    return done(e);
  }
};

//
//  Service Provider Metadata
//

const getSpidAttributesMetadata = (
  serviceProviderConfig: IServiceProviderConfig
) => {
  return serviceProviderConfig.requiredAttributes
    ? serviceProviderConfig.requiredAttributes.attributes.map(item => ({
        $: {
          FriendlyName: SPID_USER_ATTRIBUTES[item] || "",
          Name: item,
          NameFormat: "urn:oasis:names:tc:SAML:2.0:attrname-format:basic"
        }
      }))
    : [];
};

const getSpidOrganizationMetadata = (
  serviceProviderConfig: IServiceProviderConfig
) => {
  return serviceProviderConfig.organization
    ? {
        Organization: {
          OrganizationName: {
            $: { "xml:lang": "it" },
            _: serviceProviderConfig.organization.name
          },
          // must appear after organization name
          // tslint:disable-next-line: object-literal-sort-keys
          OrganizationDisplayName: {
            $: { "xml:lang": "it" },
            _: serviceProviderConfig.organization.displayName
          },
          OrganizationURL: {
            $: { "xml:lang": "it" },
            _: serviceProviderConfig.organization.URL
          }
        }
      }
    : {};
};

const getKeyInfoForMetadata = (publicCert: string, privateKey: string) => ({
  file: privateKey,
  getKey: () => Buffer.from(privateKey),
  getKeyInfo: () =>
    `<X509Data><X509Certificate>${publicCert}</X509Certificate></X509Data>`
});

export const getMetadataTamperer = (
  xmlBuilder: Builder,
  serviceProviderConfig: IServiceProviderConfig,
  samlConfig: SamlConfig
) => (generateXml: string): TaskEither<Error, string> => {
  return tryCatch(() => parseStringPromise(generateXml), toError)
    .chain(objXml => {
      return tryCatch(
        async () =>
          // tslint:disable-next-line: no-any
          produce(objXml, (o: any) => {
            const sso = o.EntityDescriptor.SPSSODescriptor[0];
            // tslint:disable-next-line: no-object-mutation
            sso.$ = {
              ...sso.$,
              AuthnRequestsSigned: true,
              WantAssertionsSigned: true
            };
            // tslint:disable-next-line: no-object-mutation
            sso.AssertionConsumerService[0].$.index = 0;
            // tslint:disable-next-line: no-object-mutation
            sso.AttributeConsumingService = {
              $: {
                index: samlConfig.attributeConsumingServiceIndex
              },
              ServiceName: {
                $: {
                  "xml:lang": "it"
                },
                _: serviceProviderConfig.requiredAttributes.name
              },
              // must appear after attributes
              // tslint:disable-next-line: object-literal-sort-keys
              RequestedAttribute: getSpidAttributesMetadata(
                serviceProviderConfig
              )
            };
            // tslint:disable-next-line: no-object-mutation
            o.EntityDescriptor = {
              ...o.EntityDescriptor,
              ...getSpidOrganizationMetadata(serviceProviderConfig)
            };
          }),
        toError
      );
    })
    .chain(_ => tryCatch(async () => xmlBuilder.buildObject(_), toError))
    .chain(xml =>
      tryCatch(async () => {
        // sign xml metadata
        if (!samlConfig.privateCert) {
          throw new Error(
            "You must provide a private key to sign SPID service provider metadata."
          );
        }
        const sig = new xmlCrypto.SignedXml();
        const publicCert = cleanCert(serviceProviderConfig.publicCert);
        // tslint:disable-next-line: no-object-mutation
        sig.keyInfoProvider = getKeyInfoForMetadata(
          publicCert,
          samlConfig.privateCert
        );
        // tslint:disable-next-line: no-object-mutation
        sig.signatureAlgorithm =
          "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
        // tslint:disable-next-line: no-object-mutation
        sig.signingKey = samlConfig.privateCert;
        sig.addReference(
          "//*[local-name(.)='EntityDescriptor']",
          [
            "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
            "http://www.w3.org/2001/10/xml-exc-c14n#"
          ],
          "http://www.w3.org/2001/04/xmlenc#sha256"
        );
        sig.computeSignature(xml, {
          // Place the signature tag before all other tags
          location: { reference: "", action: "prepend" }
        });
        return sig.getSignedXml();
      }, toError)
    );
};

//
//  Authorize request
//

export const getAuthorizeRequestTamperer = (
  xmlBuilder: Builder,
  serviceProviderConfig: IServiceProviderConfig,
  samlConfig: SamlConfig
) => (generateXml: string): TaskEither<Error, string> => {
  return tryCatch(() => parseStringPromise(generateXml), toError)
    .chain(objXml => {
      return tryCatch(
        async () =>
          // tslint:disable-next-line: no-any
          produce(objXml, (o: any) => {
            // tslint:disable-next-line: no-object-mutation no-delete
            delete objXml["samlp:AuthnRequest"]["samlp:NameIDPolicy"][0].$
              .AllowCreate;
            // tslint:disable-next-line: no-object-mutation no-deleteam
            objXml["samlp:AuthnRequest"]["saml:Issuer"][0].$.NameQualifier =
              samlConfig.issuer;
            // tslint:disable-next-line: no-object-mutation no-delete
            objXml["samlp:AuthnRequest"]["saml:Issuer"][0].$.Format =
              "urn:oasis:names:tc:SAML:2.0:nameid-format:entity";
          }),
        toError
      );
    })
    .chain(_ => tryCatch(async () => xmlBuilder.buildObject(_), toError));
};

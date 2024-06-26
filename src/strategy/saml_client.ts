import * as t from "io-ts";
import * as express from "express";
import { pipe } from "fp-ts/lib/function";
import * as O from "fp-ts/lib/Option";
import * as E from "fp-ts/Either";
import * as TE from "fp-ts/lib/TaskEither";
import { SamlConfig } from "passport-saml";
import * as PassportSaml from "passport-saml";
import { JwkPublicKeyFromToken } from "@pagopa/ts-commons/lib/jwk";
import {
  LollipopHashAlgorithm,
  LOLLIPOP_PUB_KEY_HASHING_ALGO_HEADER_NAME,
  LOLLIPOP_PUB_KEY_HEADER_NAME,
} from "../types/lollipop";
import { IExtendedCacheProvider } from "./redis_cache_provider";
import {
  PreValidateResponseDoneCallbackT,
  PreValidateResponseT,
  XmlAuthorizeTamperer,
} from "./spid";

export class CustomSamlClient<
  T extends Record<string, unknown>
> extends PassportSaml.SAML {
  // eslint-disable-next-line max-params
  constructor(
    private readonly config: SamlConfig,
    private readonly extededCacheProvider: IExtendedCacheProvider<T>,
    private readonly requestMapper?: (req: express.Request) => t.Validation<T>,
    private readonly tamperAuthorizeRequest?: XmlAuthorizeTamperer,
    private readonly preValidateResponse?: PreValidateResponseT<T>,
    private readonly doneCb?: PreValidateResponseDoneCallbackT<T>
  ) {
    // validateInResponseTo must be set to false to disable
    // internal cacheProvider of passport-saml
    super({
      ...config,
      validateInResponseTo: false,
    });
  }

  /**
   * Custom version of `validatePostResponse` which checks
   * the response XML to satisfy SPID protocol constrains
   */
  public validatePostResponse(
    body: { readonly SAMLResponse: string },
    callback: (err: Error, profile?: unknown, loggedOut?: boolean) => void
  ): void {
    if (this.preValidateResponse) {
      return this.preValidateResponse(
        this.config,
        body,
        this.extededCacheProvider,
        this.doneCb,
        (err, isValid, AuthnRequestID) => {
          if (err) {
            return callback(err);
          }
          // go on with checks in case no error is found
          return super.validatePostResponse(body, (error, user, ___) => {
            // if (!error && isValid && AuthnRequestID && !entityID.startsWith('xx_')) {
            if (!error && isValid && AuthnRequestID) {
              // eslint-disable-next-line @typescript-eslint/no-floating-promises
              pipe(
                this.extededCacheProvider.get(AuthnRequestID),
                TE.map((cachedData) => {
                  const {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    RequestXML,
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    createdAt,
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    idpIssuer,
                    ...extraLoginRequestParams
                  } = cachedData;
                  return extraLoginRequestParams;
                }),
                TE.chainFirst(() =>
                  this.extededCacheProvider.remove(AuthnRequestID)
                ),
                TE.map((extraLoginRequestParams) =>
                  callback(
                    error,
                    // Do NOT change `extraLoginRequestParams` name, unless you change the one
                    // used in `withSpidAuthMiddleware` accordingly
                    user ? { ...user, extraLoginRequestParams } : user,
                    ___
                  )
                ),
                TE.mapLeft(callback)
              )();
            } else {
              callback(error, user, ___);
            }
          });
        }
      );
    }
    super.validatePostResponse(body, callback);
  }

  /**
   * Custom version of `generateAuthorizeRequest` which tampers
   * the generated XML to satisfy SPID protocol constrains
   */
  public generateAuthorizeRequest(
    req: express.Request,
    isPassive: boolean,
    isHttpPostBinding: boolean,
    callback: (err: Error, xml?: string) => void
  ): void {
    const newCallback = pipe(
      O.fromNullable(this.tamperAuthorizeRequest),
      O.map((tamperAuthorizeRequest) => (e: Error, xml?: string): void => {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises, @typescript-eslint/no-unused-expressions
        xml
          ? pipe(
              req.headers[LOLLIPOP_PUB_KEY_HEADER_NAME],
              JwkPublicKeyFromToken.decode,
              O.fromEither,
              O.map((pubKey) => ({
                hashAlgorithm: pipe(
                  req.headers[LOLLIPOP_PUB_KEY_HASHING_ALGO_HEADER_NAME],
                  // The headers validation should happen into the Application layer.
                  // If a unsupported value is provided, the application can return a validation error.
                  // If the value is missing or unsupported the default value will be used (sha256).
                  O.fromPredicate(LollipopHashAlgorithm.is),
                  O.toUndefined
                ),
                pubKey,
              })),
              O.toUndefined,
              (lollipopParams) => tamperAuthorizeRequest(xml, lollipopParams),
              TE.chain((tamperedXml) =>
                this.extededCacheProvider.save(
                  tamperedXml,
                  this.config,
                  pipe(
                    this.requestMapper,
                    E.fromNullable(undefined),
                    E.chainW((mapper) => mapper(req)),
                    E.getOrElseW(() => undefined)
                  )
                )
              ),
              TE.mapLeft((error) => callback(error)),
              TE.map((cache) =>
                callback(null as unknown as Error, cache.RequestXML)
              )
            )()
          : callback(e);
      }),
      O.getOrElse(() => callback)
    );
    super.generateAuthorizeRequest(
      req,
      isPassive,
      isHttpPostBinding,
      newCallback
    );
  }
}

import { PrivateKeyInput } from "crypto";

export type Config = {
    /**
     * For servers that do not return Retry-After headers on 429 responses (for status calls), 
     * you can specify logic to convert an X-Progress header (if presented) into a delay time 
     * (in seconds)
     */
    xProgressToRetryAfter?: (s: string) => number,
    /**
     * A default Retry-After time (in seconds) to use for status calls,
     * if one was not provided by the server or calculable using `config.xProgressToRetryAfter` 
     */
    retryAfterDefault?: number,
    /**
     * The base url of the FHIR server to interact with
     */
    fhir_url: string,
    /**
     * The token endpoint of the FHIR server to interact with
     */
    token_url: string,
    /**
     * The client_id for your client, used to conduct the client_credentials grant
     */
    client_id: string,
    /**
     * A PEM string for your RS384 or ES384 private key, used to conduct the client_credentials grant
     */
    private_key: PrivateKeyInput
}

// type ResourceTypeConfig = {
//     resourceType: string,
//     callback: (id: string, json: object) => void;
// }

// export type GroupConfig = {
//     groupId: string,  
//     _since?: string, 
//     _outputFormat?: string,
//     patientCallback: (id: string, json: object) => void,
//     operationOutcomeCallback: (outcome: object) => void,
//     errorCallback: (error: unknown) => void,
//     resourceTypes?: ResourceTypeConfig[]
// }
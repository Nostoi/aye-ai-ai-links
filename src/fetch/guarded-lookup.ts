import { promises as dns, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

export type Resolve = (hostname: string) => Promise<LookupAddress[]>;

export class RefusedAddressError extends Error {
  readonly code = "refused_address";
}

export const systemResolve: Resolve = (hostname) => dns.lookup(hostname, { all: true });

/**
 * A `dns.lookup` replacement for the socket. It resolves every address and refuses the whole
 * answer if any one is not allowed, so the address that passed is the one connected to (no second
 * lookup to rebind). Node asks for `all: true` today; it answers in whichever shape was asked.
 */
export function guardedLookup(
  resolve: Resolve,
  isAllowed: (ip: string) => boolean,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const first = addresses[0];
        if (!first) {
          const err: NodeJS.ErrnoException = new Error(`no address for ${hostname}`);
          err.code = "ENOTFOUND";
          return callback(err, "", 0);
        }
        const bad = addresses.find((a) => !isAllowed(a.address));
        if (bad) {
          return callback(new RefusedAddressError(`${hostname} resolves to ${bad.address}`), "", 0);
        }
        if (options.all) return callback(null, addresses);
        return callback(null, first.address, first.family);
      },
      (err) => callback(err, "", 0),
    );
  };
}

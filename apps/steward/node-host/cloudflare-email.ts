/** `cloudflare:email` stand-in: the steward never sends mail through a Worker binding. */
export class EmailMessage {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly raw: string | ReadableStream,
  ) {}
}

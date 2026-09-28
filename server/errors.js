// An error whose message is safe and useful to show the user, with the HTTP status to send.
export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

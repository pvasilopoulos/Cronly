// @cronapp/notify — shared outbound notification primitives used by the worker
// (alert + heartbeat delivery, HTTP job executor) and the API (send-test). Keeps
// the SSRF guard, mail transport and channel delivery identical across both.

export { safeFetch, assertSafeUrl, isBlockedIp, BlockedUrlError } from './net-guard';
export { sendMail, type SendResult } from './mailer';
export {
  deliverToChannel,
  type DeliverChannel,
  type RenderedMessage,
  type DeliverResult,
} from './deliver';

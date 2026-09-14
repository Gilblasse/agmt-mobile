/**
 * Enough to tell one recipient from another; not enough to be a phone number.
 *
 * Used everywhere a recipient would otherwise reach a log line or the
 * `notifications.last_error` column. A driver's phone number is personal data
 * and the error column is read by whoever is debugging the queue, so the
 * number must not be sitting in it.
 */
export function masked(recipient: string): string {
  if (recipient.includes('@')) {
    const [user = '', domain = ''] = recipient.split('@');
    return `${user.slice(0, 2)}***@${domain}`;
  }
  return `***${recipient.slice(-4)}`;
}

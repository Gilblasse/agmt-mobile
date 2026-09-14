import { officeDateKey, pricingDefaults, quote } from '@ag/rules';

const OFFICE_TIME_ZONE = 'America/New_York';

/**
 * Scaffold page. Proves the server renders from the same rules package the
 * phone bundles. Replace this with the dispatcher board.
 */
export default function Home() {
  const officeDay = officeDateKey(new Date(), OFFICE_TIME_ZONE);
  const sample = quote(
    { transport: 'Wheelchair', serviceDate: '2026-09-14', scheduledTime: '09:00' },
    pricingDefaults(),
    { miles: 12, today: '2026-09-14' },
  );

  return (
    <main>
      <h1>Shared rules are running on the server</h1>
      <p>Today, by the office clock: <strong>{officeDay}</strong></p>
      <h2>Sample price — wheelchair, 12 miles</h2>
      <ul>
        {sample.lines.map((line) => (
          <li key={line.key}>
            {line.label}: ${line.amount.toFixed(2)}
          </li>
        ))}
      </ul>
      <p>Total: <strong>${sample.total.toFixed(2)}</strong></p>
      {sample.incomplete ? (
        <p>This price is not complete. It is not safe to invoice yet.</p>
      ) : null}
    </main>
  );
}

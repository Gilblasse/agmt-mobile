export const metadata = {
  title: 'Amazing Grace Dispatch',
  description: 'Dispatch board and API for Amazing Grace Mobile Transport',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: 24 }}>
        {children}
      </body>
    </html>
  );
}

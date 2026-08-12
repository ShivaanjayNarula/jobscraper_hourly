import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Job Radar',
  description: 'Fresher and entry-level roles in India and remote, straight from company ATS boards.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

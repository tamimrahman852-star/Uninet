import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { CartHost } from '@/components/layouts/CartHost';

export const metadata: Metadata = {
  title: { default: 'Uninet', template: '%s · Uninet' },
  description: 'Social, chat, shopping, video and AI in one app.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#2545e9',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <CartHost />
      </body>
    </html>
  );
}

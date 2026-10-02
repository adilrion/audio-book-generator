import type { Metadata } from 'next';
import { ShortsList } from '@/components/shorts-list';

export const metadata: Metadata = { title: 'Shorts' };

export default function ShortsPage() {
  return <ShortsList />;
}

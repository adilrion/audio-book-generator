import type { Metadata } from 'next';
import { ShortView } from '@/components/short-view';

export const metadata: Metadata = { title: 'Short' };

export default async function ShortPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ShortView id={id} />;
}

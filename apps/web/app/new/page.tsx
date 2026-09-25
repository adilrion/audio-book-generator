import type { Metadata } from 'next';
import { NewProject } from '@/components/new-project';

export const metadata: Metadata = { title: 'New audiobook' };

export default function NewPage() {
  return <NewProject />;
}

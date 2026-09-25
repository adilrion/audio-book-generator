import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="grid place-items-center gap-4 py-20 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">This page does not exist</h1>
      <Button asChild variant="outline">
        <Link href="/">Back to projects</Link>
      </Button>
    </div>
  );
}

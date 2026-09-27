import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="grid place-items-center gap-5 py-24 text-center">
      <p className="font-serif text-7xl font-medium tracking-tight text-muted-foreground/50 tabular">404</p>
      <div className="grid gap-1.5">
        <h1 className="font-serif text-3xl font-medium tracking-tight">
          This page is <span className="marker">not in the library</span>
        </h1>
        <p className="text-muted-foreground">The link may be old, or the project was deleted.</p>
      </div>
      <Button asChild variant="outline">
        <Link href="/">Back to the library</Link>
      </Button>
    </div>
  );
}

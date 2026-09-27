'use client';

import { Cpu, HardDrive, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { HealthChecks } from '@/components/health-banner';
import { PageHeader } from '@/components/page-header';
import { PowerControl } from '@/components/power-control';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { API_URL } from '@/lib/api';

function Fact({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="grid gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

/** Health of the local services, the power mode and what runs where. */
export function SystemView() {
  return (
    <div className="grid gap-8">
      <PageHeader title="System" description="The local services this Mac uses to turn books into audiobooks, and how hard they may work." />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <Card>
          <CardHeader>
            <CardTitle>Health</CardTitle>
            <CardDescription>Required components must be ready before processing; optional ones add engines and features.</CardDescription>
          </CardHeader>
          <CardContent>
            <HealthChecks />
          </CardContent>
        </Card>
        <div className="grid gap-6">
          <PowerControl id="power" />
          <Card>
            <CardHeader>
              <CardTitle>Local-first</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-4">
                <Fact icon={<ShieldCheck aria-hidden />} title="Nothing leaves this Mac">
                  PDF parsing, narration, the optional AI and video rendering all run locally — no cloud services.
                </Fact>
                <Fact icon={<Cpu aria-hidden />} title="Background worker">
                  Books are processed by the worker in the background; you can close this tab at any time.
                </Fact>
                <Fact icon={<HardDrive aria-hidden />} title="Local API">
                  <span className="font-mono text-xs break-all">{API_URL}</span>
                </Fact>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

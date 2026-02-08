"use client";

import { Badge } from "@/src/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/card";
import type { ExperienceSummaryJson } from "../types";

export function ExperienceSummaryView(props: {
  summary: ExperienceSummaryJson;
}) {
  const { summary } = props;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prompt pack</CardTitle>
          <CardDescription>
            Paste these lines into your prompt to reduce recurring errors.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="whitespace-pre-wrap rounded-md border bg-background p-2 font-mono text-xs text-muted-foreground">
            {(summary.promptPack.lines ?? []).join("\n")}
          </div>
        </CardContent>
      </Card>

      {summary.experiences.map((exp) => (
        <Card key={exp.key}>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">{exp.key}</CardTitle>
              {exp.relatedErrorTypes?.length ? (
                <div className="flex flex-wrap items-center gap-1">
                  {exp.relatedErrorTypes.slice(0, 6).map((t) => (
                    <Badge key={t} variant="secondary" className="font-mono">
                      {t}
                    </Badge>
                  ))}
                  {exp.relatedErrorTypes.length > 6 ? (
                    <Badge variant="outline">
                      +{exp.relatedErrorTypes.length - 6}
                    </Badge>
                  ) : null}
                </div>
              ) : null}
            </div>
            <CardDescription className="whitespace-pre-wrap break-words">
              {exp.when}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Possible problems
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {exp.possibleProblems.map((p, idx) => (
                    <li key={`${exp.key}-p-${idx}`} className="break-words">
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">
                  Avoidance and notes
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {exp.avoidanceAndNotes.map((a, idx) => (
                    <li key={`${exp.key}-a-${idx}`} className="break-words">
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="mt-3">
              <div className="text-xs font-medium text-muted-foreground">
                Prompt additions
              </div>
              <div className="mt-2 whitespace-pre-wrap rounded-md border bg-background p-2 font-mono text-xs text-muted-foreground">
                {exp.promptAdditions.map((l) => `- ${l}`).join("\n")}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

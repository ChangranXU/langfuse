"use client";

import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/card";
import { copyTextToClipboard } from "@/src/utils/clipboard";
import type { ExperienceSummaryJson } from "../types";

export function ExperienceSummaryView(props: {
  summary: ExperienceSummaryJson;
}) {
  const { summary } = props;
  const [copiedPromptKey, setCopiedPromptKey] = useState<string | null>(null);

  const handleCopyPromptAdditions = useCallback(
    async (params: { key: string; text: string }) => {
      try {
        await copyTextToClipboard(params.text);
        setCopiedPromptKey(params.key);
        toast.success("Copied prompt additions");
        window.setTimeout(() => {
          setCopiedPromptKey((current) =>
            current === params.key ? null : current,
          );
        }, 1500);
      } catch (error) {
        console.error("Failed to copy prompt additions", error);
        toast.error("Failed to copy prompt additions");
      }
    },
    [],
  );

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
              <div className="group relative mt-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1 z-10 h-6 w-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() =>
                    void handleCopyPromptAdditions({
                      key: exp.key,
                      text: exp.promptAdditions.map((l) => `- ${l}`).join("\n"),
                    })
                  }
                  aria-label="Copy prompt additions"
                >
                  {copiedPromptKey === exp.key ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
                <div className="whitespace-pre-wrap rounded-md border bg-background p-2 pr-10 font-mono text-xs text-muted-foreground">
                  {exp.promptAdditions.map((l) => `- ${l}`).join("\n")}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

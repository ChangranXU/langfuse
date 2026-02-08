"use client";

import { Button } from "@/src/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/src/components/ui/popover";
import { ErrorAnalysisDropdown } from "./ErrorAnalysisDropdown";

export function ErrorAnalysisButton(props: {
  projectId: string;
  traceId: string;
  observationId: string;
  level: string | null | undefined;
}) {
  if (props.level !== "ERROR" && props.level !== "WARNING") return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" className="h-6 px-2 text-xs">
          Analyze
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-3">
        <ErrorAnalysisDropdown
          projectId={props.projectId}
          traceId={props.traceId}
          observationId={props.observationId}
          level={props.level}
        />
      </PopoverContent>
    </Popover>
  );
}

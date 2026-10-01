import { HugeiconsIcon } from "@hugeicons/react"
import { AiMagicIcon, FlashIcon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Link } from "react-router"
import type { AiParse, HeuristicParse } from "@shared/types"
import { describePosition } from "@core/discs"
import { PageHeader } from "@/components/app-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"

const EXAMPLES = [
  "12_buju_banton_vs_beenie_man_live_93_dubplate.mp3",
  "03. Wiley - Wot Do U Call It (Official Video) [320kbps] www.grimeripz.com.mp3",
  "A1-Tenor_Saw-Ring_The_Alarm.mp3",
  "stone love 1995 juggling side b pt2.mp3",
  "chronixx ft protoje - here comes trouble (dubplate for king addies).flac",
  "Track 07.mp3",
]

type Result = { filename: string; heuristic: HeuristicParse; ai?: AiParse; error?: string }

function Reading({ label, icon, artists, relation, title, version, year, extra, confidence }: {
  label: string
  icon: typeof FlashIcon
  artists: string[]
  relation?: string
  title: string
  version?: string
  year?: number
  extra?: string[]
  confidence: number
}) {
  return (
    <div className="bg-muted/40 rounded-2xl p-3">
      <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs font-medium">
        <HugeiconsIcon icon={icon} strokeWidth={2} className="size-3.5" />
        {label} · {Math.round(confidence * 100)}%
      </div>
      <div className="font-medium">
        {artists.length ? artists.join(relation === "vs" ? " vs " : " & ") : <span className="text-muted-foreground italic">no artist</span>}
        <span className="text-muted-foreground"> - </span>
        {title || <span className="text-muted-foreground italic">no title</span>}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {version && <Badge variant="secondary">{version}</Badge>}
        {year && <Badge variant="outline">{year}</Badge>}
        {extra?.map((e) => (
          <Badge key={e} variant="outline">
            {e}
          </Badge>
        ))}
      </div>
    </div>
  )
}

export default function UntanglerPage() {
  const [text, setText] = useState(EXAMPLES.slice(0, 3).join("\n"))
  const [useAi, setUseAi] = useState(false)
  const [results, setResults] = useState<Result[]>([])
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: api.health })

  const run = useMutation({
    mutationFn: async () => {
      const names = text
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 25)
      const out: Result[] = []
      setResults([])
      for (const filename of names) {
        const r = await api.playground(filename, useAi)
        out.push({ filename, ...r })
        setResults([...out])
      }
      return out
    },
  })

  return (
    <>
      <PageHeader
        eyebrow="Playground"
        title="Untangler"
        description="Paste messy filenames and see how the rule-based parser and the AI read them - no files touched, nothing saved."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Filenames</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} className="font-mono text-xs" placeholder="one per line" />
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setText((t) => (t ? `${t}\n${e}` : e))}
                  className="bg-muted hover:bg-muted/70 max-w-full truncate rounded-full px-2.5 py-1 font-mono text-[11px]"
                >
                  + {e}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t pt-3">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={useAi} onCheckedChange={setUseAi} />
                Ask the AI too
              </label>
              <span className="text-muted-foreground text-xs">
                {health?.llm ? `${health.llm.label} · ${health.llm.model || "no model"}` : <Link to="/settings#ai">no AI provider - set one up</Link>}
              </span>
              <Button className="ml-auto" onClick={() => run.mutate()} disabled={run.isPending}>
                {run.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={AiMagicIcon} strokeWidth={2} data-icon="inline-start" />}
                Untangle
              </Button>
            </div>
          </CardContent>
        </Card>
        <div className="space-y-3">
          {results.length === 0 && <div className="text-muted-foreground rounded-3xl border border-dashed p-8 text-center text-sm">Readings show up here.</div>}
          {results.map((r) => (
            <Card key={r.filename} size="sm">
              <CardContent className="space-y-2">
                <div className="font-mono text-xs break-all">{r.filename}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Reading
                    label="Rule-based"
                    icon={FlashIcon}
                    artists={r.heuristic.artists}
                    relation={r.heuristic.relation}
                    title={r.heuristic.title}
                    version={r.heuristic.version}
                    year={r.heuristic.year}
                    extra={[...r.heuristic.hints, ...(r.heuristic.position ? [describePosition(r.heuristic.position) ?? ""] : [])].filter(Boolean)}
                    confidence={r.heuristic.confidence}
                  />
                  {r.ai ? (
                    <Reading
                      label={`AI · ${r.ai.model}`}
                      icon={AiMagicIcon}
                      artists={r.ai.artists}
                      relation={r.ai.relation}
                      title={r.ai.title}
                      version={r.ai.version}
                      year={r.ai.year}
                      extra={[r.ai.riddim && `${r.ai.riddim} riddim`, r.ai.event].filter(Boolean) as string[]}
                      confidence={r.ai.confidence}
                    />
                  ) : r.error ? (
                    <div className="bg-rasta-red/10 text-rasta-red rounded-2xl p-3 text-xs">{r.error}</div>
                  ) : null}
                </div>
                {r.ai?.reasoning && <p className="text-muted-foreground text-xs">{r.ai.reasoning}</p>}
                {!!r.heuristic.notes.length && <p className="text-muted-foreground text-[11px]">Parser: {r.heuristic.notes.join(" · ")}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </>
  )
}

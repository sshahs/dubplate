import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, ArrowRight02Icon, Tick02Icon, Video01Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router"
import { toast } from "sonner"
import type { MediaProbe, Settings } from "@shared/types"
import { PageHeader } from "@/components/app-shell"
import { QueryError } from "@/components/query-error"
import { SettingRow, SettingRows } from "@/components/settings-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { api, type VideoItem } from "@/lib/api"
import { useActiveJobs } from "@/lib/events"
import { fmtBytes, fmtDuration } from "@/lib/format"
import { cn } from "@/lib/utils"

const ENCODE_TO = [
  { value: "mp3", label: "MP3 (VBR V0)" },
  { value: "m4a", label: "AAC 256 kbps (.m4a)" },
  { value: "flac", label: "FLAC (lossless, bigger)" },
]

/** "AAC · 44.1 kHz stereo · 128 kbps" */
function inside(p: MediaProbe | null): string {
  const a = p?.audio[0]
  if (!p) return "Not looked at yet"
  if (!a) return "No audio in it"
  const ch = a.channels === 1 ? "mono" : a.channels === 2 ? "stereo" : a.channels ? `${a.channels} channels` : null
  return [a.codecName, [a.sampleRate ? `${a.sampleRate / 1000} kHz` : null, ch].filter(Boolean).join(" "), a.bitRate ? `${Math.round(a.bitRate / 1000)} kbps` : null].filter(Boolean).join(" · ")
}

const STATUS: Record<VideoItem["status"], { label: string; className: string }> = {
  found: { label: "waiting", className: "" },
  converted: { label: "converted", className: "text-rasta-green" },
  failed: { label: "failed", className: "text-rasta-red" },
  "no-audio": { label: "no audio", className: "text-muted-foreground" },
}

function VideoRow({ v, onConvert, busy }: { v: VideoItem; onConvert: () => void; busy: boolean }) {
  const s = STATUS[v.status]
  const out = v.outputPath?.split(/[\\/]/).pop()
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="bg-muted text-muted-foreground mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl">
        <HugeiconsIcon icon={Video01Icon} strokeWidth={2} className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium break-all">{v.filename}</span>
          <Badge variant="outline" className={cn("font-normal", s.className)}>
            {s.label}
          </Badge>
        </div>
        <div className="text-muted-foreground text-xs">
          {v.library}
          {v.relDir ? ` / ${v.relDir}` : ""} · {fmtBytes(v.size)}
          {v.probe?.duration ? ` · ${fmtDuration(v.probe.duration)}` : ""}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
          <span>{inside(v.probe)}</span>
          {v.status === "converted" && out ? (
            <>
              <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} className="text-rasta-gold size-3.5 shrink-0" />
              <span className="font-medium break-all">{out}</span>
              {v.asideFrom && <span className="text-muted-foreground">(video set aside)</span>}
            </>
          ) : (
            v.plan &&
            v.status !== "no-audio" && (
              <>
                <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} className="text-muted-foreground size-3.5 shrink-0" />
                <span className="text-muted-foreground">{v.plan.label}</span>
              </>
            )
          )}
        </div>
        {v.status === "failed" && v.error && <p className="text-rasta-red mt-1 text-xs break-words">{v.error}</p>}
      </div>
      {(v.status === "found" || v.status === "failed") && (
        <Button size="sm" variant="outline" onClick={onConvert} disabled={busy}>
          {v.status === "failed" ? "Try again" : "Convert"}
        </Button>
      )}
    </li>
  )
}

/** The converter's options, saved as they change. */
function ConvertOptions({ value, holding, readOnly }: { value: Settings["convert"]; holding: string; readOnly: boolean }) {
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (patch: Partial<Settings["convert"]>) => api.saveSettings({ convert: { ...value, ...patch } }),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s)
      void qc.invalidateQueries({ queryKey: ["videos"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const originals = [
    { value: "keep", label: "Stays where it is" },
    { value: "aside", label: `Moves to "${holding}"` },
  ]
  return (
    <Card>
      <CardHeader>
        <CardTitle>How it converts</CardTitle>
        <CardDescription className="text-pretty">The audio file goes next to the video, with the same name. Nothing is overwritten, and Rewind in Cut & Tag takes a conversion back.</CardDescription>
      </CardHeader>
      <CardContent>
        <SettingRows>
          <SettingRow title="Keep the audio as it is" description="AAC, MP3, WMA, Vorbis and Opus are copied out untouched, so nothing is lost; uncompressed audio becomes FLAC. Off: everything is re-encoded.">
            <Switch checked={value.keepAudio} onCheckedChange={(v) => save.mutate({ keepAudio: v })} aria-label="Keep the audio as it is" />
          </SettingRow>
          <SettingRow title="Re-encode to" description="For audio an audio file can't hold as it is: AMR from old phones, Dolby Digital, ADPCM…">
            <Select items={ENCODE_TO} value={value.encodeTo} onValueChange={(v) => save.mutate({ encodeTo: v as Settings["convert"]["encodeTo"] })}>
              <SelectTrigger className="w-full sm:w-64" aria-label="Re-encode to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENCODE_TO.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow title="Afterwards, the video" description={readOnly && value.originals === "aside" ? "Read-only mode is on, so for now it stays where it is." : "Set aside like a duplicate: scans skip it, and nothing is deleted."}>
            <Select items={originals} value={value.originals} onValueChange={(v) => save.mutate({ originals: v as Settings["convert"]["originals"] })}>
              <SelectTrigger className="w-full sm:w-64" aria-label="Afterwards, the video">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {originals.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow title="Convert new videos automatically" description="Whenever a scan finds one; the audio is then identified like any new file.">
            <Switch checked={value.auto} onCheckedChange={(v) => save.mutate({ auto: v })} aria-label="Convert new videos automatically" />
          </SettingRow>
        </SettingRows>
      </CardContent>
    </Card>
  )
}

export default function VideosPage() {
  const { data, error, refetch, isLoading } = useQuery({ queryKey: ["videos"], queryFn: api.videos })
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const converting = useActiveJobs().some((j) => j.kind === "convert")
  const convert = useMutation({
    mutationFn: (ids?: number[]) => api.convertVideos(ids),
    onSuccess: (j) => toast(j.label, { description: "The audio files are scanned and identified when it's done." }),
    onError: (e) => toast.error(e.message),
  })
  const items = data?.items ?? []
  const waiting = items.filter((v) => v.status === "found" || v.status === "failed")
  const busy = converting || convert.isPending
  const exts = settings?.scanner.videoExtensions ?? []

  return (
    <>
      <PageHeader
        eyebrow="Converter"
        title="Videos"
        description="Music videos, phone clips and old rips: Dubplate pulls the audio out into an audio file next to each one, which is then identified and tagged like any other track."
      />
      {error && !data ? (
        <QueryError error={error} onRetry={() => void refetch()} />
      ) : (
        <div className="space-y-4">
          {data && !data.ffmpeg && (
            <Card className="border-rasta-gold/40">
              <CardContent className="flex gap-3 text-sm">
                <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="text-rasta-gold mt-0.5 size-5 shrink-0" />
                <div className="space-y-1">
                  <div className="font-medium">ffmpeg isn't installed</div>
                  <p className="text-muted-foreground text-pretty">
                    It's what pulls the audio out. The Docker image comes with it; running Dubplate yourself, install ffmpeg (or set FFMPEG_PATH) and restart. Videos are still listed meanwhile.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>In your libraries</CardTitle>
              <CardDescription>
                {isLoading ? "Looking…" : items.length ? `${items.length} video${items.length === 1 ? "" : "s"}, ${waiting.length} to convert.` : "Scans list them; nothing is changed until you convert."}
              </CardDescription>
              {waiting.length > 0 && (
                <CardAction>
                  <Button size="sm" onClick={() => convert.mutate(waiting.map((v) => v.id))} disabled={busy || !data?.ffmpeg}>
                    {busy ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} data-icon="inline-start" />}
                    {converting ? "Converting…" : `Convert ${waiting.length === 1 ? "it" : `all ${waiting.length}`}`}
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }, (_, i) => (
                    <Skeleton key={i} className="h-16 rounded-2xl" />
                  ))}
                </div>
              ) : items.length ? (
                <ul className="divide-border/70 divide-y overflow-hidden rounded-2xl border">
                  {items.map((v) => (
                    <VideoRow key={v.id} v={v} busy={busy || !data?.ffmpeg} onConvert={() => convert.mutate([v.id])} />
                  ))}
                </ul>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <HugeiconsIcon icon={Video01Icon} strokeWidth={2} />
                    </EmptyMedia>
                    <EmptyTitle>No videos found</EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      Scans look for {exts.map((e) => `.${e}`).join(", ") || "video files"} (Settings → Sign-in & safety → Scanner). Scan a library from{" "}
                      <Link to="/libraries" className="underline underline-offset-2">
                        Libraries
                      </Link>{" "}
                      to look again.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>

          {settings && <ConvertOptions value={settings.convert} holding={settings.duplicates.holdingFolder} readOnly={settings.safety.readOnly} />}
        </div>
      )}
    </>
  )
}

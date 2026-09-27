import { HugeiconsIcon } from "@hugeicons/react"
import { Add01Icon, Alert02Icon, Delete02Icon, DiscordIcon, TelegramIcon, TestTube01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import type { MediaServerConfig, MediaServerKind } from "@shared/types"
import { SettingRow, SettingRows } from "@/components/settings-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { api, type PublicSettings } from "@/lib/api"
import { cn } from "@/lib/utils"

type Set = (fn: (d: PublicSettings) => void) => void
type Result = { ok: boolean; message: string } | null

function TestResult({ result }: { result: Result }) {
  if (!result) return null
  return (
    <span className={cn("flex items-center gap-1.5 text-xs", result.ok ? "text-rasta-green" : "text-rasta-red")} role="status">
      <HugeiconsIcon icon={result.ok ? Tick02Icon : Alert02Icon} strokeWidth={2} className="size-3.5 shrink-0" />
      {result.message}
    </span>
  )
}

function TestButton({ onTest, pending, disabled }: { onTest: () => void; pending: boolean; disabled?: boolean }) {
  return (
    <Button size="sm" variant="outline" onClick={onTest} disabled={pending || disabled}>
      {pending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} data-icon="inline-start" />}
      Send a test
    </Button>
  )
}

// ---------- Discord & Telegram ----------

export function ChatSettings({ draft, set }: { draft: PublicSettings; set: Set }) {
  const i = draft.integrations
  const [results, setResults] = useState<Record<string, Result>>({})
  const test = useMutation({
    mutationFn: (channel: "discord" | "telegram") => api.testChat(channel, i),
    onSuccess: (r, channel) => setResults((x) => ({ ...x, [channel]: r.ok ? { ok: true, message: "Sent - check the channel" } : r })),
    onError: (e, channel) => setResults((x) => ({ ...x, [channel]: { ok: false, message: e.message } })),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Discord & Telegram</CardTitle>
        <CardDescription>A message when a long job finishes or new tracks are waiting for a listen, wherever you are. Handy when Dubplate runs on a server.</CardDescription>
      </CardHeader>
      <CardContent>
        <SettingRows>
          <SettingRow
            stack
            title={
              <span className="flex items-center gap-2">
                <HugeiconsIcon icon={DiscordIcon} strokeWidth={2} className="size-4" />
                Discord
              </span>
            }
            description="Channel settings → Integrations → Webhooks → New webhook, then copy its URL."
          >
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Input
                  value={i.discord.webhookUrl ?? ""}
                  onChange={(e) => set((d) => void (d.integrations.discord.webhookUrl = e.target.value))}
                  placeholder="https://discord.com/api/webhooks/…"
                  className="font-mono text-xs"
                  aria-label="Discord webhook URL"
                  autoComplete="off"
                />
                <Switch checked={i.discord.enabled} onCheckedChange={(v) => set((d) => void (d.integrations.discord.enabled = v))} aria-label="Send to Discord" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <TestButton onTest={() => test.mutate("discord")} pending={test.isPending && test.variables === "discord"} disabled={!i.discord.webhookUrl} />
                <TestResult result={results.discord ?? null} />
              </div>
            </div>
          </SettingRow>
          <SettingRow
            stack
            title={
              <span className="flex items-center gap-2">
                <HugeiconsIcon icon={TelegramIcon} strokeWidth={2} className="size-4" />
                Telegram
              </span>
            }
            description="Make a bot with @BotFather and paste its token. Send the bot a message, then get your chat ID from @userinfobot (a group's ID starts with -)."
          >
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="grid flex-1 gap-2 sm:grid-cols-[1fr_12rem]">
                  <Input
                    type="password"
                    value={i.telegram.botToken ?? ""}
                    onChange={(e) => set((d) => void (d.integrations.telegram.botToken = e.target.value))}
                    placeholder="Bot token"
                    aria-label="Telegram bot token"
                    autoComplete="off"
                  />
                  <Input value={i.telegram.chatId ?? ""} onChange={(e) => set((d) => void (d.integrations.telegram.chatId = e.target.value))} placeholder="Chat ID" aria-label="Telegram chat ID" />
                </div>
                <Switch checked={i.telegram.enabled} onCheckedChange={(v) => set((d) => void (d.integrations.telegram.enabled = v))} aria-label="Send to Telegram" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <TestButton onTest={() => test.mutate("telegram")} pending={test.isPending && test.variables === "telegram"} disabled={!i.telegram.botToken || !i.telegram.chatId} />
                <TestResult result={results.telegram ?? null} />
              </div>
            </div>
          </SettingRow>
          <SettingRow title="When a job finishes" description="Anything that ran over 30 seconds, every cut, organise and rewind, and anything that failed.">
            <Switch checked={i.notify.jobs} onCheckedChange={(v) => set((d) => void (d.integrations.notify.jobs = v))} aria-label="Message when a job finishes" />
          </SettingRow>
          <SettingRow title="When tracks need a listen" description="After identifying, if any tracks went to Review.">
            <Switch checked={i.notify.review} onCheckedChange={(v) => set((d) => void (d.integrations.notify.review = v))} aria-label="Message when tracks need a listen" />
          </SettingRow>
          <SettingRow htmlFor="public-url" title="Dubplate's address" description="How you reach Dubplate from your phone, so messages can link straight to it. Leave empty for no links.">
            <Input
              id="public-url"
              value={i.publicUrl}
              onChange={(e) => set((d) => void (d.integrations.publicUrl = e.target.value))}
              placeholder="http://nas.local:4455"
              className="w-full font-mono text-xs sm:w-64"
            />
          </SettingRow>
        </SettingRows>
      </CardContent>
    </Card>
  )
}

// ---------- media servers ----------

const KINDS: { kind: MediaServerKind; label: string; url: string; token: string; help: string }[] = [
  { kind: "plex", label: "Plex", url: "http://localhost:32400", token: "X-Plex-Token", help: "Find the token by viewing any item's XML in Plex Web (Get Info → View XML): it's the X-Plex-Token in the address." },
  { kind: "jellyfin", label: "Jellyfin / Emby", url: "http://localhost:8096", token: "API key", help: "Dashboard → API Keys → add one for Dubplate." },
  { kind: "navidrome", label: "Navidrome", url: "http://localhost:4533", token: "Password", help: "Any Navidrome user; Dubplate uses the Subsonic API to start a scan." },
]

const kindOf = (k: MediaServerKind) => KINDS.find((x) => x.kind === k)!

function ServerRow({ server, onChange, onRemove }: { server: MediaServerConfig; onChange: (m: MediaServerConfig) => void; onRemove: () => void }) {
  const kind = kindOf(server.kind)
  const [result, setResult] = useState<Result>(null)
  const test = useMutation({
    mutationFn: () => api.testMediaServer(server),
    onSuccess: setResult,
    onError: (e) => setResult({ ok: false, message: e.message }),
  })
  return (
    <div className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <Badge variant="outline">{kind.label}</Badge>
        <Input value={server.name} onChange={(e) => onChange({ ...server, name: e.target.value })} className="h-8 max-w-56" aria-label="Name" />
        <span className="flex-1" />
        <Switch checked={server.enabled} onCheckedChange={(v) => onChange({ ...server, enabled: v })} aria-label={`Rescan ${server.name}`} />
        <Button size="icon-sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${server.name}`}>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </Button>
      </div>
      <div className={cn("grid gap-2", server.kind === "navidrome" ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <Input value={server.url} onChange={(e) => onChange({ ...server, url: e.target.value })} placeholder={kind.url} className="font-mono text-xs" aria-label="Address" />
        {server.kind === "navidrome" && <Input value={server.user ?? ""} onChange={(e) => onChange({ ...server, user: e.target.value })} placeholder="User" aria-label="User" autoComplete="off" />}
        <Input type="password" value={server.token ?? ""} onChange={(e) => onChange({ ...server, token: e.target.value })} placeholder={kind.token} aria-label={kind.token} autoComplete="off" />
      </div>
      <p className="text-muted-foreground text-xs">{kind.help}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !server.url}>
          {test.isPending ? <Spinner data-icon="inline-start" /> : <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} data-icon="inline-start" />}
          Test
        </Button>
        <TestResult result={result} />
      </div>
    </div>
  )
}

export function MediaServerSettings({ draft, set }: { draft: PublicSettings; set: Set }) {
  const servers = draft.integrations.mediaServers
  const add = (kind: MediaServerKind) =>
    set((d) => void d.integrations.mediaServers.push({ id: `${kind}-${Date.now().toString(36)}`, kind, name: kindOf(kind).label.split(" ")[0], url: "", enabled: true }))
  return (
    <Card>
      <CardHeader>
        <CardTitle>Media servers</CardTitle>
        <CardDescription>After every cut, organise, rewind or duplicate clean-up, Dubplate asks these to rescan, so new names and folders show up straight away.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {servers.length > 0 && (
          <div className="divide-border/70 divide-y">
            {servers.map((m, i) => (
              <ServerRow
                key={m.id}
                server={m}
                onChange={(next) => set((d) => void (d.integrations.mediaServers[i] = next))}
                onRemove={() => set((d) => void d.integrations.mediaServers.splice(i, 1))}
              />
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <Button key={k.kind} size="sm" variant={servers.length ? "ghost" : "outline"} onClick={() => add(k.kind)}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
              {k.label}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

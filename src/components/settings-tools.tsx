import { HugeiconsIcon } from "@hugeicons/react"
import { Copy01Icon, Delete02Icon, Key01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import type { ApiToken } from "@shared/types"
import { PathMapEditor } from "@/components/dj-export-dialog"
import { SettingRow, SettingRows } from "@/components/settings-layout"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, type PublicSettings } from "@/lib/api"
import { fmtAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

type SetDraft = (fn: (d: PublicSettings) => void) => void

const SCOPES = [
  { value: "hooks" as const, label: "Downloads & uploads only" },
  { value: "full" as const, label: "Everything (for scripts)" },
]

const HOOK_LABELS = { from: "Folder as the download tool sees it", to: "The same folder as Dubplate sees it", fromHint: "/downloads", toHint: "/music/Downloads" }

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          },
          () => toast.error("Couldn't copy - select it and copy by hand")
        )
      }
    >
      <HugeiconsIcon icon={done ? Tick02Icon : Copy01Icon} strokeWidth={2} data-icon="inline-start" />
      {done ? "Copied" : label}
    </Button>
  )
}

function Snippet({ text }: { text: string }) {
  return (
    <div className="bg-muted/50 relative rounded-xl border">
      <pre className="overflow-x-auto p-3 pr-20 font-mono text-[11px] leading-relaxed whitespace-pre">{text}</pre>
      <div className="absolute top-2 right-2">
        <CopyButton text={text} />
      </div>
    </div>
  )
}

/** Keys for scripts and download tools, each shown once when it's made. */
function TokensCard({ onCreated }: { onCreated: (token: string) => void }) {
  const qc = useQueryClient()
  const { data: tokens } = useQuery({ queryKey: ["tokens"], queryFn: api.tokens })
  const [name, setName] = useState("")
  const [scope, setScope] = useState<ApiToken["scope"]>("hooks")
  const [fresh, setFresh] = useState<(ApiToken & { token: string }) | null>(null)
  const create = useMutation({
    mutationFn: () => api.createToken(name, scope),
    onSuccess: (t) => {
      setFresh(t)
      setName("")
      onCreated(t.token)
      void qc.invalidateQueries({ queryKey: ["tokens"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteToken(id),
    onSuccess: (_r, id) => {
      if (fresh?.id === id) setFresh(null)
      void qc.invalidateQueries({ queryKey: ["tokens"] })
      toast("Token deleted", { description: "Anything using it is turned away from now on." })
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>API tokens</CardTitle>
        <CardDescription>For download tools and scripts, which can't sign in. Make one per tool, so you can delete one without breaking the others.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <Input aria-label="Token name" placeholder="Name, e.g. qBittorrent" value={name} onChange={(e) => setName(e.target.value)} className="sm:max-w-56" />
          <Select items={SCOPES} value={scope} onValueChange={(v) => setScope(v as ApiToken["scope"])}>
            <SelectTrigger aria-label="What it may do" className="sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCOPES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            <HugeiconsIcon icon={Key01Icon} strokeWidth={2} data-icon="inline-start" />
            Make a token
          </Button>
        </form>

        {fresh && (
          <div className="border-rasta-green/40 bg-rasta-green/8 animate-in fade-in slide-in-from-top-1 space-y-2 rounded-2xl border p-3 duration-200" role="status">
            <div className="text-sm font-medium">“{fresh.name}” is ready. Copy it now: it won't be shown again.</div>
            <div className="flex items-center gap-2">
              <code className="bg-background min-w-0 flex-1 truncate rounded-lg border px-2 py-1.5 font-mono text-xs">{fresh.token}</code>
              <CopyButton text={fresh.token} />
            </div>
            <p className="text-muted-foreground text-xs">The setup below has it filled in.</p>
          </div>
        )}

        {tokens?.length ? (
          <ul className="divide-y text-sm">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{t.name}</span>
                    <Badge variant={t.scope === "full" ? "destructive" : "secondary"}>{t.scope === "full" ? "everything" : "downloads & uploads"}</Badge>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    <span className="font-mono">{t.prefix}…</span> · made {fmtAgo(t.createdAt)} · {t.lastUsedAt ? `last used ${fmtAgo(t.lastUsedAt)}` : "never used"}
                  </div>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger render={<Button variant="ghost" size="icon" aria-label={`Delete ${t.name}`} />}>
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete “{t.name}”?</AlertDialogTitle>
                      <AlertDialogDescription>Whatever uses it can't reach Dubplate any more until you give it a new token.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => remove.mutate(t.id)}>
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No tokens yet.</p>
        )}
      </CardContent>
    </Card>
  )
}

/** Ready-made setup for each download tool, with this server's address and the new token filled in. */
function SetupTabs({ base, token }: { base: string; token: string }) {
  const hook = `${base}/api/hooks/import`
  const tools = [
    {
      id: "qbittorrent",
      label: "qBittorrent",
      how: (
        <>
          Options → Downloads → <b>Run external program</b> → <b>Run on torrent finished</b>. It needs <code>curl</code> where qBittorrent runs.
        </>
      ),
      snippet: `curl -fsS -X POST -H "Authorization: Bearer ${token}" --data-urlencode "path=%F" "${hook}?from=qBittorrent"`,
    },
    {
      id: "slskd",
      label: "slskd",
      how: (
        <>
          Add to slskd's config file (a version with webhooks), then restart it. It calls Dubplate when a folder finishes downloading.
        </>
      ),
      snippet: `integration:
  webhooks:
    dubplate:
      on:
        - DownloadDirectoryComplete
      call:
        url: ${hook}
        headers:
          - name: Authorization
            value: Bearer ${token}`,
    },
    {
      id: "lidarr",
      label: "Lidarr",
      how: (
        <>
          Settings → Connect → + → <b>Webhook</b>. Tick <b>On Release Import</b> and <b>On Upgrade</b>, method POST, any username, and the token as the password. <b>Test</b> shows up
          below.
        </>
      ),
      snippet: `URL:       ${hook}\nMethod:    POST\nUsername:  lidarr\nPassword:  ${token}`,
    },
    {
      id: "other",
      label: "Anything else",
      how: <>Send the folder or file that finished. A form field or ?path= works too, and a library by name: {`{"library": "Downloads"}`}.</>,
      snippet: `curl -X POST "${hook}" \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"path": "/downloads/Some Album"}'`,
    },
  ]
  return (
    <Tabs defaultValue="qbittorrent">
      <TabsList className="flex-wrap">
        {tools.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tools.map((t) => (
        <TabsContent key={t.id} value={t.id} className="mt-3 space-y-2">
          <p className="text-muted-foreground text-xs text-pretty">{t.how}</p>
          <Snippet text={t.snippet} />
        </TabsContent>
      ))}
    </Tabs>
  )
}

function RecentCalls() {
  const { data } = useQuery({ queryKey: ["hook-calls"], queryFn: api.hookCalls, refetchInterval: 10_000 })
  if (!data?.length) return <p className="text-muted-foreground text-xs">No calls since Dubplate started. Use the tool's test button, or finish a download.</p>
  return (
    <ul className="divide-y text-xs">
      {data.slice(0, 8).map((c, i) => {
        const bad = !c.test && !c.libraries.length
        return (
          <li key={`${c.at}-${i}`} className="space-y-0.5 py-2">
            <div className="flex items-center gap-2">
              <span className="font-medium">{c.from}</span>
              <span className="text-muted-foreground">
                {c.token} · {fmtAgo(c.at)}
              </span>
              <span className={cn("ml-auto shrink-0", bad ? "text-rasta-gold" : "text-rasta-green")}>{c.test ? "test - it works" : bad ? "nothing to scan" : `scanning ${c.libraries.join(", ")}`}</span>
            </div>
            {c.paths.length > 0 && <div className="text-muted-foreground truncate font-mono">{c.paths.join(" · ")}</div>}
            {c.ignored.map((x) => (
              <div key={x.path} className="text-rasta-gold">
                <span className="font-mono">{x.path}</span>: {x.reason}
              </div>
            ))}
          </li>
        )
      })}
    </ul>
  )
}

/** Settings → Uploads & download tools. */
export function ToolsSettings({ draft, set }: { draft: PublicSettings; set: SetDraft }) {
  const [token, setToken] = useState<string | null>(null)
  const base = draft.integrations.publicUrl || window.location.origin
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Upload from your phone</CardTitle>
          <CardDescription>
            <Link to="/upload" className="underline underline-offset-2">
              Upload
            </Link>{" "}
            puts files straight into a library - an inbox, ideally, so hands-off files them. On a phone with Dubplate installed, you can also share audio files to it from other apps. An upload
            never replaces a file: a name that's taken gets a number.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRows>
            <SettingRow htmlFor="upload-max" title="Largest file" description="In MB. A proxy in front of Dubplate may have a lower limit of its own.">
              <Input
                id="upload-max"
                type="number"
                min={1}
                className="w-28"
                value={draft.uploads.maxMb}
                onChange={(e) => set((d) => void (d.uploads.maxMb = Math.max(1, Number(e.target.value) || 1)))}
              />
            </SettingRow>
          </SettingRows>
        </CardContent>
      </Card>

      <TokensCard onCreated={setToken} />

      <Card>
        <CardHeader>
          <CardTitle>Download tools</CardTitle>
          <CardDescription>
            When a download finishes, the tool tells Dubplate, which scans the library it landed in and identifies what's new. The download folder has to be a library - make it an inbox
            with hands-off on, and finished downloads file themselves.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <SettingRows>
            <SettingRow stack title="If the tool sees the folders elsewhere" description="In Docker, say, qBittorrent may call it /downloads while Dubplate has it at /music/Downloads.">
              <PathMapEditor value={draft.hooks.pathMap} onChange={(v) => set((d) => void (d.hooks.pathMap = v))} labels={HOOK_LABELS} />
            </SettingRow>
          </SettingRows>
          <div className="space-y-2">
            <div className="text-sm font-medium">Set it up</div>
            {!token && <p className="text-muted-foreground text-xs">Make a token above and it's filled in here; until then it says YOUR_TOKEN.</p>}
            <SetupTabs base={base} token={token ?? "YOUR_TOKEN"} />
          </div>
          <div className="space-y-1">
            <div className="text-sm font-medium">Recent calls</div>
            <RecentCalls />
          </div>
        </CardContent>
      </Card>
    </>
  )
}

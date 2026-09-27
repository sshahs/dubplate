import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import type { AuthStatus } from "@shared/types"
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
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { AUTH_KEY, useAuth } from "@/lib/auth"

const MIN = 8

/** Set, change or remove the password in front of Dubplate. */
export function PasswordSettings() {
  const qc = useQueryClient()
  const { status } = useAuth()
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [again, setAgain] = useState("")
  const reset = () => {
    setCurrent("")
    setNext("")
    setAgain("")
  }
  const save = useMutation({
    mutationFn: () => api.setPassword(status?.enabled ? current : undefined, next),
    onSuccess: (s) => {
      qc.setQueryData<AuthStatus>(AUTH_KEY, { ...s, authenticated: true })
      toast.success(status?.enabled ? "Password changed" : "Password set", { description: "Everyone else has to sign in again. You stay signed in here." })
      reset()
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: () => api.removePassword(current),
    onSuccess: (s) => {
      qc.setQueryData<AuthStatus>(AUTH_KEY, s)
      toast.success("Password removed", { description: "Anyone who can reach Dubplate can use it now." })
      reset()
    },
    onError: (e) => toast.error(e.message),
  })
  const everywhere = useMutation({
    mutationFn: api.logoutEverywhere,
    onSuccess: () => toast.success("Signed out everywhere else"),
    onError: (e) => toast.error(e.message),
  })

  if (!status) return null
  const tooShort = next.length > 0 && next.length < MIN
  const mismatch = again.length > 0 && again !== next
  const ready = next.length >= MIN && next === again && (!status.enabled || current.length > 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          {status.fromEnv
            ? "Set with DUBPLATE_PASSWORD on the server, so it's changed there."
            : status.enabled
              ? "Dubplate asks for it on every new browser. Changing it signs everyone else out."
              : "Anyone who can reach Dubplate can use it. Set a password if it's on a server or your home network."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!status.fromEnv && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (ready) save.mutate()
            }}
          >
            <input type="text" name="username" autoComplete="username" value="dubplate" readOnly hidden />
            <SettingRows>
              {status.enabled && (
                <SettingRow htmlFor="pw-current" title="Current password">
                  <Input id="pw-current" type="password" autoComplete="current-password" className="w-full sm:w-64" value={current} onChange={(e) => setCurrent(e.target.value)} />
                </SettingRow>
              )}
              <SettingRow htmlFor="pw-new" title={status.enabled ? "New password" : "Password"} description={`At least ${MIN} characters.`}>
                <Input
                  id="pw-new"
                  type="password"
                  autoComplete="new-password"
                  className="w-full sm:w-64"
                  value={next}
                  aria-invalid={tooShort || undefined}
                  onChange={(e) => setNext(e.target.value)}
                />
              </SettingRow>
              <SettingRow htmlFor="pw-again" title="Type it again" description={mismatch ? "Doesn't match yet." : undefined}>
                <Input
                  id="pw-again"
                  type="password"
                  autoComplete="new-password"
                  className="w-full sm:w-64"
                  value={again}
                  aria-invalid={mismatch || undefined}
                  onChange={(e) => setAgain(e.target.value)}
                />
              </SettingRow>
            </SettingRows>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              {status.enabled && (
                <AlertDialog>
                  <AlertDialogTrigger render={<Button type="button" variant="ghost" disabled={!current} />}>Remove password</AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove the password?</AlertDialogTitle>
                      <AlertDialogDescription>Anyone who can reach Dubplate will be able to rename, tag and move your files.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
              <Button type="submit" disabled={!ready || save.isPending}>
                {save.isPending && <Spinner data-icon="inline-start" />}
                {status.enabled ? "Change password" : "Set password"}
              </Button>
            </div>
          </form>
        )}
        {status.enabled && (
          <SettingRows className={status.fromEnv ? undefined : "mt-4 border-t pt-2"}>
            <SettingRow title="Sign out everywhere else" description="Every other browser and phone has to sign in again.">
              <Button variant="outline" onClick={() => everywhere.mutate()} disabled={everywhere.isPending}>
                Sign out others
              </Button>
            </SettingRow>
          </SettingRows>
        )}
      </CardContent>
    </Card>
  )
}

// Presentation overlay for the pinned /assistant route.
// The assistant reads the live device catalogue, verified DP points, Haier
// state and local /api/local/* read endpoints. It never sends a device command
// and never runs a scene or rule: every plan is a draft reviewed on Automations.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Bot,
  Info,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, Panel } from "@/components/sp/primitives";
import { messageOf } from "@/lib/smartpilot/backend-api";
import {
  buildSuggestions,
  loadLiveFacts,
  respond,
  type Advisory,
  type AssistantContext,
  type AssistantDraft,
  type AssistantReply,
  type ChatLink,
  type ChatMessage,
  type LiveFacts,
} from "@/lib/smartpilot/assistant";
import { useSmartPilot } from "@/lib/smartpilot/store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/assistant")({
  head: () => ({
    meta: [
      { title: "Smart Auto-Pilot Assistant — Smart Pilot" },
      {
        name: "description",
        content:
          "Local assistant that explains verified device status and drafts plans you review on Automations. It never sends commands.",
      },
      { property: "og:title", content: "Smart Auto-Pilot Assistant — Smart Pilot" },
      {
        property: "og:description",
        content: "Chat about verified device specs and local Auto-Pilot rules. No commands are sent from chat.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AssistantPage,
});

const uid = () => Math.random().toString(36).slice(2, 10);

function LinkRow({ links }: { links: ChatLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {links.map((link) => (
        <Button
          key={`${link.to}-${link.label}`}
          asChild
          variant="link"
          size="sm"
          className="h-11 min-w-11 px-2"
        >
          <Link to={link.to}>{link.label}</Link>
        </Button>
      ))}
    </div>
  );
}

function AdvisoryCard({ advisory }: { advisory: Advisory }) {
  return (
    <div
      className={cn(
        "mt-2 rounded-2xl border p-3 text-left text-sm",
        advisory.tone === "warning" && "border-status-preview/30 bg-status-preview/8",
        advisory.tone === "safety" && "border-status-offline/30 bg-status-offline/8",
        advisory.tone === "info" && "border-glass-border bg-muted/40",
      )}
    >
      <p className="flex items-center gap-2 font-semibold">
        {advisory.tone === "info" ? (
          <Info className="size-4 text-primary" aria-hidden />
        ) : advisory.tone === "warning" ? (
          <AlertTriangle className="size-4 text-status-preview" aria-hidden />
        ) : (
          <ShieldAlert className="size-4 text-status-offline" aria-hidden />
        )}
        {advisory.title}
      </p>
      <p className="mt-0.5 text-muted-foreground">{advisory.body}</p>
      {advisory.links ? <LinkRow links={advisory.links} /> : null}
    </div>
  );
}

function DraftCard({ draft }: { draft: AssistantDraft }) {
  return (
    <div className="mt-3 rounded-2xl border border-primary/30 bg-primary/6 p-4">
      <Badge variant="info">
        <Sparkles className="size-3" aria-hidden /> Draft plan — review before running
      </Badge>
      <p className="mt-2 font-semibold">{draft.title}</p>
      <p className="text-sm text-muted-foreground">{draft.reason}</p>
      <ul className="mt-3 space-y-1 text-sm">
        {draft.steps.map((step, index) => (
          <li key={index} className="flex gap-2">
            <span className="text-primary" aria-hidden>
              •
            </span>
            <span className="min-w-0">{step}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground" role="note">
        <ShieldAlert className="mt-px size-3.5 shrink-0 text-status-preview" aria-hidden />
        No command was sent. Create and run this on Automations only after you explicitly confirm.
      </p>
      <div className="mt-2">
        <LinkRow links={[{ label: "Open Automations", to: draft.to }]} />
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <li className={cn("flex gap-3 animate-rise", isUser && "flex-row-reverse")}>
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-2xl",
          isUser
            ? "bg-secondary text-secondary-foreground"
            : "bg-gradient-primary text-primary-foreground",
        )}
      >
        {isUser ? <User className="size-4" aria-hidden /> : <Bot className="size-4" aria-hidden />}
      </span>
      <div className={cn("min-w-0 max-w-[85%] sm:max-w-[75%]", isUser && "text-right")}>
        <div
          className={cn(
            "inline-block rounded-3xl px-4 py-3 text-left text-sm leading-relaxed",
            isUser ? "rounded-tr-lg bg-primary text-primary-foreground" : "glass rounded-tl-lg",
          )}
        >
          {msg.text}
        </div>
        {msg.advisories?.map((advisory, index) => (
          <AdvisoryCard key={index} advisory={advisory} />
        ))}
        {msg.links ? <LinkRow links={msg.links} /> : null}
        {msg.draft ? <DraftCard draft={msg.draft} /> : null}
      </div>
    </li>
  );
}

function AssistantPage() {
  const { t, state, devices, points, connection, setChat, log } = useSmartPilot();
  const [facts, setFacts] = useState<LiveFacts | null>(null);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void loadLiveFacts()
      .then((next) => {
        if (mounted.current) setFacts(next);
      })
      .catch(() => {
        /* failed reads stay unclaimed; no sample data is substituted */
      });
  }, []);

  const context = useMemo<AssistantContext>(
    () => ({ devices, points, ac: state.ac, connection }),
    [devices, points, state.ac, connection],
  );
  const suggestions = useMemo(() => buildSuggestions(context, facts), [context, facts]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state.chat.length, thinking]);

  const send = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!question || thinking) return;
      setInput("");
      setChat((current) => [
        ...current,
        { id: uid(), role: "user", text: question, at: new Date().toISOString() },
      ]);
      setThinking(true);
      try {
        const latest = await loadLiveFacts();
        if (!mounted.current) return;
        setFacts(latest);
        const reply: AssistantReply = respond(question, context, latest);
        setChat((current) => [
          ...current,
          {
            id: uid(),
            role: "assistant",
            text: reply.text,
            at: new Date().toISOString(),
            ...(reply.advisories?.length ? { advisories: reply.advisories } : {}),
            ...(reply.links?.length ? { links: reply.links } : {}),
            ...(reply.draft ? { draft: reply.draft } : {}),
          },
        ]);
        if (reply.draft) {
          log({
            kind: "assistant",
            status: "info",
            title: `Assistant drafted: ${reply.draft.title}`,
            detail: "Advisory only — no device command was sent.",
          });
        }
      } catch (error) {
        if (mounted.current) {
          setChat((current) => [
            ...current,
            {
              id: uid(),
              role: "assistant",
              text: `I couldn't check local data (${messageOf(error)}). Nothing was sent.`,
              at: new Date().toISOString(),
            },
          ]);
        }
      } finally {
        if (mounted.current) setThinking(false);
      }
    },
    [thinking, context, setChat, log],
  );

  return (
    <div className="flex flex-col">
      <PageHeader
        title={t("assistant_title")}
        sub="Reads your verified devices and local rules. Explains what is supported and drafts plans you review on Automations."
        eyebrow={
          <Badge variant="info">
            <Bot className="size-3" aria-hidden /> Live local guidance
          </Badge>
        }
        actions={
          state.chat.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setChat(() => [])}>
              <Trash2 /> Clear chat
            </Button>
          ) : null
        }
      />

      <div
        className="mb-4 flex items-start gap-2 rounded-2xl border border-glass-border bg-muted/40 p-3 text-sm"
        role="note"
      >
        <ShieldCheck className="mt-px size-4 shrink-0 text-primary" aria-hidden />
        <p>
          Advisory only — no commands from chat. Review drafts on{" "}
          <Link to="/automations" className="text-primary underline">Automations</Link>.
        </p>
      </div>

      <Panel className="flex min-h-[55dvh] flex-col" pad="none">
        <div className="flex-1 p-4 sm:p-6" aria-live="polite">
          {state.chat.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center py-10 text-center">
              <span className="grid size-16 place-items-center rounded-3xl bg-gradient-primary text-primary-foreground glow">
                <Sparkles className="size-7" aria-hidden />
              </span>
              <p className="mt-4 font-display text-lg font-semibold">
                How can I help at home today?
              </p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                I read your verified device specs and local rules. I explain what is supported and
                draft plans you review on Automations. I never send commands.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Badge variant="ok">
                  <ShieldCheck className="size-3" aria-hidden /> Verified reads only
                </Badge>
                <Badge variant="unknown">
                  <ShieldAlert className="size-3" aria-hidden /> No commands from chat
                </Badge>
              </div>
            </div>
          ) : (
            <ul className="space-y-5">
              {state.chat.map((message) => (
                <Bubble key={message.id} msg={message} />
              ))}
              {thinking && (
                <li className="flex items-center gap-3 text-sm text-muted-foreground">
                  <span className="grid size-9 place-items-center rounded-2xl bg-gradient-primary text-primary-foreground">
                    <Bot className="size-4" aria-hidden />
                  </span>
                  <span className="flex gap-1" aria-label="Assistant is preparing a local answer">
                    <span className="size-2 animate-bounce rounded-full bg-primary" />
                    <span className="size-2 animate-bounce rounded-full bg-primary [animation-delay:120ms]" />
                    <span className="size-2 animate-bounce rounded-full bg-primary [animation-delay:240ms]" />
                  </span>
                </li>
              )}
            </ul>
          )}
          <div ref={endRef} className="scroll-mb-56 md:scroll-mb-44" />
        </div>

        <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] border-t border-glass-border p-3 glass-strong rounded-b-3xl sm:p-4 md:bottom-0">
          <div
            className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1 scrollbar-none"
            role="group"
            aria-label="Suggestions based on your devices"
          >
            {suggestions.map((suggestion) => (
              <Button
                key={suggestion}
                variant="chip"
                size="sm"
                className="h-9 shrink-0"
                onClick={() => void send(suggestion)}
                disabled={thinking}
              >
                {suggestion}
              </Button>
            ))}
          </div>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              placeholder={t("ask_placeholder")}
              aria-label={t("ask_placeholder")}
              className="min-h-11 resize-none rounded-2xl bg-background/60"
            />
            <Button
              type="submit"
              variant="hero"
              size="icon-touch"
              aria-label={t("send")}
              disabled={!input.trim() || thinking}
            >
              <Send />
            </Button>
          </form>
        </div>
      </Panel>
    </div>
  );
}

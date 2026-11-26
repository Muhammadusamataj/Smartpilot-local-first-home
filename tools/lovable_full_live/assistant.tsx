import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUpRight,
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
    <div className="mt-2.5 flex flex-wrap gap-2">
      {links.map((link) => (
        <Button
          key={`${link.to}-${link.label}`}
          asChild
          variant="glass"
          size="sm"
          className="h-11 min-w-11 rounded-full px-3.5 text-xs"
        >
          <Link to={link.to}>
            {link.label}
            <ArrowUpRight className="size-3.5 opacity-75" aria-hidden />
          </Link>
        </Button>
      ))}
    </div>
  );
}

function AdvisoryCard({ advisory }: { advisory: Advisory }) {
  return (
    <div
      className={cn(
        "mt-2.5 rounded-2xl border p-3.5 text-left text-sm",
        advisory.tone === "warning" && "border-status-preview/30 bg-status-preview/8",
        advisory.tone === "safety" && "border-status-offline/30 bg-status-offline/8",
        advisory.tone === "info" && "border-glass-border bg-muted/40",
      )}
    >
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
        {advisory.tone === "info" ? (
          <Info className="size-3.5 text-primary" aria-hidden />
        ) : advisory.tone === "warning" ? (
          <AlertTriangle className="size-3.5 text-status-preview" aria-hidden />
        ) : (
          <ShieldAlert className="size-3.5 text-status-offline" aria-hidden />
        )}
        <span>{advisory.title}</span>
      </p>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{advisory.body}</p>
      {advisory.links ? <LinkRow links={advisory.links} /> : null}
    </div>
  );
}

function DraftCard({ draft }: { draft: AssistantDraft }) {
  return (
    <div className="mt-3 rounded-2xl border border-primary/25 bg-primary/6 p-4 text-left">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="info" className="rounded-full">
          <Sparkles className="size-3" aria-hidden /> Draft plan
        </Badge>
        <span className="text-[11px] text-muted-foreground">Read-only draft</span>
      </div>
      <p className="mt-2.5 text-sm font-semibold text-foreground">{draft.title}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{draft.reason}</p>
      <ol className="mt-3 space-y-1.5 rounded-xl bg-background/50 p-3 text-xs leading-relaxed">
        {draft.steps.map((step, index) => (
          <li key={`${index}-${step}`} className="flex gap-2.5">
            <span className="font-semibold text-primary tabular" aria-hidden>
              {index + 1}.
            </span>
            <span className="min-w-0 text-foreground/90">{step}</span>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldAlert className="size-3.5 shrink-0 text-status-preview" aria-hidden />
          Review &amp; enable on Automations before running.
        </span>
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
          "mt-0.5 grid size-9 shrink-0 place-items-center rounded-2xl shadow-xs",
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
            "inline-block rounded-3xl px-4 py-2.5 text-left text-sm leading-relaxed",
            isUser
              ? "rounded-tr-md bg-primary text-primary-foreground shadow-xs"
              : "glass rounded-tl-md text-foreground",
          )}
        >
          {msg.text}
        </div>
        {msg.advisories?.map((advisory, index) => (
          <AdvisoryCard key={`${index}-${advisory.title}`} advisory={advisory} />
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
  const contextRef = useRef(context);
  contextRef.current = context;

  const suggestions = useMemo(() => buildSuggestions(context, facts), [context, facts]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state.chat.length, thinking]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [input]);

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
        const reply: AssistantReply = respond(question, contextRef.current, latest);
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
    [thinking, setChat, log],
  );

  return (
    <div className="flex flex-col space-y-4">
      <PageHeader
        title={t("assistant_title")}
        sub="Explains verified device capabilities and drafts plans for Automations without sending commands."
        eyebrow={
          <Badge variant="info" className="rounded-full">
            <Bot className="size-3" aria-hidden /> Live local guidance
          </Badge>
        }
        actions={
          state.chat.length > 0 ? (
            <Button
              variant="ghost"
              size="touch"
              className="rounded-full text-muted-foreground hover:text-foreground"
              onClick={() => setChat(() => [])}
            >
              <Trash2 className="size-3.5" aria-hidden /> Clear
            </Button>
          ) : null
        }
      />

      <div
        className="flex items-center gap-2.5 rounded-2xl border border-glass-border bg-muted/35 px-3.5 py-2.5 text-xs text-muted-foreground"
        role="note"
      >
        <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden />
        <p className="min-w-0">
          Read-only guidance — commands never run from chat. Drafts can be reviewed on{" "}
          <Link to="/automations" className="font-medium text-foreground underline underline-offset-4">
            Automations
          </Link>
          .
        </p>
      </div>

      <Panel className="flex min-h-[58dvh] flex-col overflow-hidden" pad="none">
        <div className="flex-1 overflow-y-auto p-4 sm:p-6" aria-live="polite">
          {state.chat.length === 0 ? (
            <div className="flex h-full min-h-[32dvh] flex-col items-center justify-center py-8 text-center">
              <span className="grid size-16 place-items-center rounded-3xl bg-gradient-primary text-primary-foreground shadow-sm">
                <Sparkles className="size-7" aria-hidden />
              </span>
              <h2 className="mt-4 font-display text-lg font-semibold tracking-tight">
                How can I help at home today?
              </h2>
              <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
                Ask about verified device status, supported capabilities, or draft a routine to
                review on Automations.
              </p>
            </div>
          ) : (
            <ul className="space-y-5">
              {state.chat.map((message) => (
                <Bubble key={message.id} msg={message} />
              ))}
              {thinking && (
                <li className="flex items-center gap-3 text-sm text-muted-foreground">
                  <span className="grid size-9 shrink-0 place-items-center rounded-2xl bg-gradient-primary text-primary-foreground">
                    <Bot className="size-4" aria-hidden />
                  </span>
                  <span
                    className="inline-flex items-center gap-1 rounded-2xl bg-muted/50 px-3.5 py-2.5"
                    aria-label="Assistant is preparing a local answer"
                  >
                    <span className="size-1.5 animate-bounce rounded-full bg-primary" />
                    <span className="size-1.5 animate-bounce rounded-full bg-primary [animation-delay:120ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-primary [animation-delay:240ms]" />
                  </span>
                </li>
              )}
            </ul>
          )}
          <div ref={endRef} />
        </div>

        <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] rounded-b-3xl border-t border-glass-border p-3 glass-strong sm:p-4 md:bottom-0">
          <div
            className="-mx-1 mb-2.5 flex gap-1.5 overflow-x-auto px-1 pb-1 scrollbar-none"
            role="group"
            aria-label="Suggestions based on your devices"
          >
            {suggestions.map((suggestion) => (
              <Button
                key={suggestion}
                variant="chip"
                size="touch"
                className="h-11 shrink-0 rounded-full px-3 text-xs"
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
              ref={textareaRef}
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
              className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl bg-background/70 py-2.5 text-sm leading-snug"
            />
            <Button
              type="submit"
              variant="hero"
              size="icon-touch"
              aria-label={t("send")}
              disabled={!input.trim() || thinking}
              className="shrink-0 rounded-2xl"
            >
              <Send className="size-4" aria-hidden />
            </Button>
          </form>
        </div>
      </Panel>
    </div>
  );
}

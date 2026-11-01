# ADR 0030: Grok on the menu, and explicit romance only there

Status: accepted (owner request, 1 Nov 2026)

## Context

The play app called Claude only. Romance was a fade-to-black line in the contract, because Anthropic's usage policy forbids depicting sex acts and erotic chat. xAI's acceptable use policy does not have that ban. It still forbids sexualising children and pornographic likenesses of real people. The player asked to pick the model from the right-hand menu, to add Grok, and to let romance be explicit.

## Decisions

The menu lists Claude Sonnet, Claude Haiku, and Grok. The choice is kept in the browser and sent with each new book, turn, and redo. The server maps it onto the provider and the strong-tier model. Cheap repairs and chapter writes use Haiku while Claude is selected, and Grok 4.7 while Grok is selected. A model whose key is missing is shown and cannot be selected.

Grok is a new provider, `xai`, on the Responses API. Requests are not stored on xAI. Reasoning cannot be disabled, so effort stays low: a high effort would bill hidden tokens at the output rate and blow the per-account cap. The visible reply stays under the existing output cap.

Romance stays faded on Claude. On Grok the contract allows explicit sexual scenes between adults and still forbids any sexual content involving minors. Clean books stay non-sexual on every model.

## Consequences

`XAI_API_KEY` has to be set before Grok can be chosen. Grok 4.7 is priced at $2 / $0.50 cached / $6 per million tokens under the long-context threshold. Reasoning tokens are extra output and count against the five-dollar account cap.

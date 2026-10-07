As the somewhat playful name suggests, this document is intended for human readers and prospective users so that I can assure them, in my own personally typed words:

1. Why this fork exists
2. Why I decided to publish it
3. My plans for the fork

Because, as you've probably seen *all* over the repo, this extension is "AI assisted." And AI is an amazing tool, capable of letting technically competent but programming-phobic people like me create fully functional GNOME extensions with better user experiences than some purely meat-made extensions. It also allows people to crap out a fork of an extension in 5 minutes, throw it onto public GitHub just because they can, and then promptly abandon it. The rest of this document was written to convince you that, if nothing else: a literate GNOME 46 user who actually cares is behind this.

# 1. Why this fork exists

This is probably the biggest question you want answered, and I doubt it will disappoint you.

**TL;DR: I am a Linux Mint 22.3 Cinnamon user who uses GNOME.**

The longer explanation for people who enjoy long Linux stories is: I started using Linux Mint as my first Linux distro, and honestly, I've never really regretted it. That is, until I revisited GNOME as the desktop environment of choice for my *ThinkPad T14* laptop. Because laptops have *very* different needs than desktop computers, and I already knew by that point GNOME *with extensions* can be a more than viable alternative (or in my case *companion*) for Cinnamon--especially for laptops, where GNOME sports significantly better touchpad and touch*screen* support. Moreover, I also know that GNOME has the unique quality of being unusually tailored *for* enjoyable laptop use. Even for somebody whose laptop setup is relatively sedentary, it's still nice to be able to just pick up the laptop, use its built-in trackpad and keyboard, and get work done about as effectively as I possibly can given the physical limitations of that hardware.

That is all to say: *I switched to GNOME because I wanted a better laptop DE.* But it was when I began experimenting with *ChatGPT 5.6* that I quickly realized how, just as I hoped, ChatGPT was already more than competent enough with JavaScript and code validation that it can absolutely write working extension code. The issue was no longer just getting runnable extensions; it was getting the AI to understand GNOME well enough to not screw up every time it needs to do something shell-related that doesn't have 50 example answers sitting online.

And this is where I have to admit: **I have little to no actual JavaScript programming experience.** In some people's eyes, that's almost immediately discrediting. And don't get me wrong: I *do* plan to at least learn *JavaScript* someday, as I have plans to release many more AI-assisted extensions, and I know that if I want more people to take me seriously, I at least need to be able to demonstrate that I know what most of the *generic JavaScript* is doing.

But this is where practicality comes into play. We are no longer in the GPT 5.6 era, we are in the 6th series of GPT models. And that number isn't just being sped up to make it seem like OpenAI is making more rapid progress than they are (although that may be part of it): GPT-6 and Codex are now genuinely capable coding agents, provided their work is directed and checked carefully. So yes, I *am* relying on the AI to do its job correctly when given clear instructions and all it needs to work. But at least for me, I've seen (and generated) more than enough evidence that *AI is now worth relying on.* Or at least, *I'm* willing to rely on it.

And with that...

# 2. Why I decided to publish it

Given that this extension is by most definitions "vibe-coded": *why did I decide to publish it?*

Because there's a reason people distinguish agentic programming from simply asking a chatbot for code: there is a *long* distance between saying "ChatGPT, make extension, no bugs," and going out of your way to ensure the best possible output for both yourself and others. I hope this document makes it clear I'm not doing the former, but I suppose now's the time to make my argument for why the distinction matters at all.

Unsurprisingly, I hold the pragmatic position on AI: I find it exceedingly unlikely that this incredibly helpful and revolutionary technology *that's already producing good enough results for GNOME extensions alone* is going to go away any time soon. I can watch as my $20 Plus subscription aggressively balloons in actual value as the models just get more and more competent at the things I need them to do. The question of whether AI is worthwhile to implement into my workflow is long since answered.

Of course, you're free to disagree with me on everything I just said, and similarly you're obviously free to not use the extension. However, for those of you willing to run partially ChatGPT-generated *open-source* code on your GNOME machines, and who believe I will do what I can to keep the extension comfortable and safe to use: I hope you manage to find some value in this niche little AI-assisted fork.

# 3. My plans for the fork

First, let's start with the concern some of you may have caught in point 1: **Linux Mint 22 is going to be the last version of Linux Mint to even *include* GNOME 46,** and of course I don't plan to keep my workstation laptop stranded with an older version of Linux Mint, so I'll be upgrading to *Linux Mint 23 Adrien* ([lol](https://github.com/IAmEidrien)) when it releases (currently expected around December 2026), which will be based on *Ubuntu 26.04 LTS*, which has *GNOME 50* in its repos, thus removing my need for this extension entirely.

Of course, once I migrate, there's really no need for me to maintain this GNOME 46-specific fork anymore (even to the extent that "maintaining" an extension means in this context). So, once that migration happens: I will put this repo into archive mode, and *assuming that nobody else is willing to maintain this GNOME 46-specific fork*, it'll stay that way.

Next, this extension will not attempt to be added to the official GNOME Extensions website, unless I hear a convincing argument to try. There's already enough obsolete "this only works for an older version of GNOME" extensions out there as-is, and I don't want to add to that mess by offering another version of an existing extension exclusively for an *officially unsupported* version of GNOME.

Lastly: *pull requests, issues/requests, and other GitHub stuff.* This is my first time managing a public repo, but obviously I'm willing to learn what goes into it if it means offering a better repo. So why are pull requests disabled? Well, as you should know by now, I take my role as maintainer/"director" seriously, but I can't yet read actual JavaScript. That means I am in no position to actually verify and pass pull requests. "So why don't I just let the AI verify them, then, if I trust them so much?" Simple: I do not trust an AI-only review process to reliably catch malicious code submitted by someone who knows how to exploit its weaknesses. So, again, unless another maintainer with sufficient JavaScript knowledge joins the fork: no pulls; only issues. That's probably all that's necessary anyway, honestly.

---

But with that, I suppose that's all I have to say for now. Thank you for reading.

-- Eidrien

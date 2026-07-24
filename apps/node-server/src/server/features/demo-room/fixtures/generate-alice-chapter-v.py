#!/usr/bin/env python3
"""Generate the Alice-Chapter-V demo utterance fixture.

Source text: Alice's Adventures in Wonderland by Lewis Carroll, Chapter V
("Advice from a Caterpillar"), Project Gutenberg eBook #11.
https://www.gutenberg.org/files/11/11-h/11-h.htm#chap05
Public domain. This file only stores the *spoken dialogue* (quoted speech)
of the chapter, split into short utterances and attributed to a speaker.

Timing model: ~3 spoken words per second. Each utterance's duration is
words/3 (min 1.0s). A 0.3s pause separates consecutive fragments of the same
turn; a 0.8s pause separates turns (emulates the gap between speakers/phrases).
`progresstxt` is a hand-authored mock interim hypothesis a speech-to-text
engine might emit at the half-way point: a shortened, sometimes slightly wrong
guess that the final `spoken` text corrects.
"""
import json

WPS = 3.0
GAP_WITHIN_TURN = 0.3
GAP_BETWEEN_TURNS = 0.8

# Each turn: (speaker, [(spoken, progresstxt), ...])
# progresstxt "" means no interim is shown for that (very short) fragment.
TURNS = [
    ("caterpillar", [("Who are you?", "who are")]),
    ("alice", [
        ("I—I hardly know, sir, just at present—", "I hardly know sir just at"),
        ("at least I know who I was when I got up this morning,", "at least I know who I was when I got"),
        ("but I think I must have been changed several times since then.", "but I think I must have been changed"),
    ]),
    ("caterpillar", [("What do you mean by that? Explain yourself!", "what do you mean by that")]),
    ("alice", [
        ("I can't explain myself, I'm afraid, sir,", "I can't explain myself I'm afraid"),
        ("because I'm not myself, you see.", "because I'm not myself you"),
    ]),
    ("caterpillar", [("I don't see.", "I don't")]),
    ("alice", [
        ("I'm afraid I can't put it more clearly,", "I'm afraid I can't put it more"),
        ("for I can't understand it myself to begin with;", "for I can't understand it myself to"),
        ("and being so many different sizes in a day is very confusing.", "and being so many different sizes in a day"),
    ]),
    ("caterpillar", [("It isn't.", "")]),
    ("alice", [
        ("Well, perhaps you haven't found it so yet,", "well perhaps you haven't found it so"),
        ("but when you have to turn into a chrysalis—you will some day, you know—", "but when you have to turn into a crystal is you will"),
        ("and then after that into a butterfly,", "and then after that into a butter"),
        ("I should think you'll feel it a little queer, won't you?", "I should think you'll feel it a little queer"),
    ]),
    ("caterpillar", [("Not a bit.", "not a")]),
    ("alice", [
        ("Well, perhaps your feelings may be different,", "well perhaps your feelings may be"),
        ("all I know is, it would feel very queer to me.", "all I know is it would feel very"),
    ]),
    ("caterpillar", [("You! Who are you?", "you who are")]),
    ("alice", [("I think, you ought to tell me who you are, first.", "I think you ought to tell me who you")]),
    ("caterpillar", [("Why?", "")]),
    ("caterpillar", [
        ("Come back!", ""),
        ("I've something important to say!", "I've something important to"),
    ]),
    ("caterpillar", [("Keep your temper.", "keep your")]),
    ("alice", [("Is that all?", "is that")]),
    ("caterpillar", [("No.", "")]),
    ("caterpillar", [("So you think you're changed, do you?", "so you think you're changed")]),
    ("alice", [
        ("I'm afraid I am, sir,", "I'm afraid I am"),
        ("I can't remember things as I used—", "I can't remember things as I"),
        ("and I don't keep the same size for ten minutes together!", "and I don't keep the same sighs for ten"),
    ]),
    ("caterpillar", [("Can't remember what things?", "can't remember what")]),
    ("alice", [
        ("Well, I've tried to say \"How doth the little busy bee,\"", "well I've tried to say how does the little busy"),
        ("but it all came different!", "but it all came"),
    ]),
    ("caterpillar", [("Repeat, 'You are old, Father William,'", "repeat you are old father")]),
    # Alice recites the poem "You are old, Father William" (8 stanzas).
    ("alice", [
        ("\"You are old, Father William,\" the young man said, \"And your hair has become very white;",
         "you are old father william the young man said and your"),
        ("And yet you incessantly stand on your head— Do you think, at your age, it is right?\"",
         "and yet you incessantly stand on your head do you think"),
        ("\"In my youth,\" Father William replied to his son, \"I feared it might injure the brain;",
         "in my youth father william replied to his son I feared"),
        ("But, now that I'm perfectly sure I have none, Why, I do it again and again.\"",
         "but now that I'm perfectly sure I have none why I"),
        ("\"You are old,\" said the youth, \"as I mentioned before, And have grown most uncommonly fat;",
         "you are old said the youth as I mentioned before and"),
        ("Yet you turned a back-somersault in at the door— Pray, what is the reason of that?\"",
         "yet you turned a back somersault in at the door pray"),
        ("\"In my youth,\" said the sage, as he shook his grey locks, \"I kept all my limbs very supple",
         "in my youth said the sage as he shook his grey"),
        ("By the use of this ointment—one shilling the box— Allow me to sell you a couple?\"",
         "by the use of this ointment one shilling the box allow"),
        ("\"You are old,\" said the youth, \"and your jaws are too weak For anything tougher than suet;",
         "you are old said the youth and your jaws are too"),
        ("Yet you finished the goose, with the bones and the beak— Pray, how did you manage to do it?\"",
         "yet you finished the goose with the bones and the beak"),
        ("\"In my youth,\" said his father, \"I took to the law, And argued each case with my wife;",
         "in my youth said his father I took to the law"),
        ("And the muscular strength, which it gave to my jaw, Has lasted the rest of my life.\"",
         "and the muscular strength which it gave to my jaw has"),
        ("\"You are old,\" said the youth, \"one would hardly suppose That your eye was as steady as ever;",
         "you are old said the youth one would hardly suppose that"),
        ("Yet you balanced an eel on the end of your nose— What made you so awfully clever?\"",
         "yet you balanced an eel on the end of your nose"),
        ("\"I have answered three questions, and that is enough,\" Said his father; \"don't give yourself airs!",
         "I have answered three questions and that is enough said his"),
        ("Do you think I can listen all day to such stuff? Be off, or I'll kick you down stairs!\"",
         "do you think I can listen all day to such stuff"),
    ]),
    ("caterpillar", [("That is not said right.", "that is not said")]),
    ("alice", [
        ("Not quite right, I'm afraid,", "not quite right I'm"),
        ("some of the words have got altered.", "some of the words have got"),
    ]),
    ("caterpillar", [("It is wrong from beginning to end.", "it is wrong from beginning")]),
    ("caterpillar", [("What size do you want to be?", "what size do you want")]),
    ("alice", [
        ("Oh, I'm not particular as to size,", "oh I'm not particular as to"),
        ("only one doesn't like changing so often, you know.", "only one doesn't like changing so often"),
    ]),
    ("caterpillar", [("I don't know.", "I don't")]),
    ("caterpillar", [("Are you content now?", "are you content")]),
    ("alice", [
        ("Well, I should like to be a little larger, sir,", "well I should like to be a little larger"),
        ("if you wouldn't mind,", "if you wouldn't"),
        ("three inches is such a wretched height to be.", "three inches is such a wretched height"),
    ]),
    ("caterpillar", [("It is a very good height indeed!", "it is a very good height")]),
    ("alice", [("But I'm not used to it!", "but I'm not used to")]),
    ("caterpillar", [("You'll get used to it in time.", "you'll get used to it in")]),
    ("caterpillar", [
        ("One side will make you grow taller,", "one side will make you grow"),
        ("and the other side will make you grow shorter.", "and the other side will make you grow"),
    ]),
    ("caterpillar", [("Of the mushroom.", "of the")]),
    ("alice", [("And now which is which?", "and now which is")]),
    ("alice", [("Come, my head's free at last!", "come my head's free at")]),
    ("alice", [
        ("What can all that green stuff be?", "what can all that green stuff"),
        ("And where have my shoulders got to?", "and where have my shoulders got"),
        ("And oh, my poor hands,", "and oh my poor"),
        ("how is it I can't see you?", "how is it I can't see"),
    ]),
    ("pigeon", [("Serpent!", "")]),
    ("alice", [
        ("I'm not a serpent!", "I'm not a"),
        ("Let me alone!", "let me"),
    ]),
    ("pigeon", [
        ("Serpent, I say again!", "serpent I say"),
        ("I've tried every way,", "I've tried every"),
        ("and nothing seems to suit them!", "and nothing seems to suit"),
    ]),
    ("alice", [("I haven't the least idea what you're talking about.", "I haven't the least idea what you're")]),
    ("pigeon", [
        ("I've tried the roots of trees,", "I've tried the roots of"),
        ("and I've tried banks, and I've tried hedges,", "and I've tried banks and I've tried"),
        ("but those serpents! There's no pleasing them!", "but those serpents there's no pleasing"),
    ]),
    ("pigeon", [
        ("As if it wasn't trouble enough hatching the eggs,", "as if it wasn't trouble enough hatching"),
        ("but I must be on the look-out for serpents night and day!", "but I must be on the lookout for serpents night"),
        ("Why, I haven't had a wink of sleep these three weeks!", "why I haven't had a wink of sleep these"),
    ]),
    ("alice", [("I'm very sorry you've been annoyed.", "I'm very sorry you've been")]),
    ("pigeon", [
        ("And just as I'd taken the highest tree in the wood,", "and just as I'd taken the highest tree in"),
        ("and just as I was thinking I should be free of them at last,", "and just as I was thinking I should be free of"),
        ("they must needs come wriggling down from the sky! Ugh, Serpent!", "they must needs come wriggling down from the sky"),
    ]),
    ("alice", [
        ("But I'm not a serpent, I tell you!", "but I'm not a serpent I tell"),
        ("I'm a—I'm a—", "I'm a"),
    ]),
    ("pigeon", [
        ("Well! What are you?", "well what are"),
        ("I can see you're trying to invent something!", "I can see you're trying to invent"),
    ]),
    ("alice", [("I—I'm a little girl,", "I'm a little")]),
    ("pigeon", [
        ("A likely story indeed!", "a likely story"),
        ("I've seen a good many little girls in my time,", "I've seen a good many little girls in my"),
        ("but never one with such a neck as that!", "but never one with such a neck as"),
        ("No, no! You're a serpent; and there's no use denying it.", "no no you're a serpent and there's no use"),
        ("I suppose you'll be telling me next that you never tasted an egg!", "I suppose you'll be telling me next that you never"),
    ]),
    ("alice", [
        ("I have tasted eggs, certainly,", "I have tasted eggs"),
        ("but little girls eat eggs quite as much as serpents do, you know.", "but little girls eat eggs quite as much as serpents"),
    ]),
    ("pigeon", [
        ("I don't believe it,", "I don't believe"),
        ("but if they do, why then they're a kind of serpent,", "but if they do why then they're a kind of"),
        ("that's all I can say.", "that's all I can"),
    ]),
    ("pigeon", [
        ("You're looking for eggs, I know that well enough;", "you're looking for eggs I know that well"),
        ("and what does it matter to me", "and what does it matter to"),
        ("whether you're a little girl or a serpent?", "whether you're a little girl or a"),
    ]),
    ("alice", [
        ("It matters a good deal to me,", "it matters a good deal to"),
        ("but I'm not looking for eggs, as it happens;", "but I'm not looking for eggs as it"),
        ("and if I was, I shouldn't want yours:", "and if I was I shouldn't want"),
        ("I don't like them raw.", "I don't like them"),
    ]),
    ("pigeon", [("Well, be off, then!", "well be off")]),
    ("alice", [
        ("Come, there's half my plan done now!", "come there's half my plan done"),
        ("How puzzling all these changes are!", "how puzzling all these changes"),
        ("I'm never sure what I'm going to be, from one minute to another!", "I'm never sure what I'm going to be from one"),
        ("However, I've got back to my right size:", "however I've got back to my right"),
        ("the next thing is, to get into that beautiful garden—", "the next thing is to get into that beautiful"),
        ("how is that to be done, I wonder?", "how is that to be done I"),
    ]),
]


def word_count(s):
    return len([w for w in s.replace("—", " ").split() if w.strip()])


utterances = []
t = 0.0
for ti, (speaker, chunks) in enumerate(TURNS):
    if ti > 0:
        t += GAP_BETWEEN_TURNS
    for ci, (spoken, progress) in enumerate(chunks):
        if ci > 0:
            t += GAP_WITHIN_TURN
        dur = max(1.0, word_count(spoken) / WPS)
        start = round(t, 2)
        end = round(t + dur, 2)
        utterances.append({
            "start": start,
            "end": end,
            "speaker": speaker,
            "spoken": spoken,
            "progresstxt": progress,
        })
        t = end

doc = {
    "$schema": "./alice-chapter-v.utterances.schema.json",
    "source": {
        "title": "Alice's Adventures in Wonderland",
        "author": "Lewis Carroll",
        "chapter": "Chapter V — Advice from a Caterpillar",
        "attribution": "Project Gutenberg eBook #11 (public domain).",
        "url": "https://www.gutenberg.org/files/11/11-h/11-h.htm#chap05",
        "note": "Spoken dialogue only, extracted from #chap05 up to where #chap06 begins. Text is in the public domain; this fixture is for local/dev caption playback.",
    },
    "timing": {
        "wordsPerSecond": WPS,
        "gapWithinTurnSeconds": GAP_WITHIN_TURN,
        "gapBetweenTurnsSeconds": GAP_BETWEEN_TURNS,
        "progressEmittedAtFractionOfDuration": 0.5,
    },
    "speakers": ["caterpillar", "alice", "pigeon"],
    "loop": True,
    "totalDurationSeconds": round(utterances[-1]["end"], 2),
    "utteranceCount": len(utterances),
    "utterances": utterances,
}

print(json.dumps(doc, indent=2, ensure_ascii=False))

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate the Alice demo utterance fixture.

Source text: Alice's Adventures in Wonderland by Lewis Carroll, Chapters
I-VI, Project Gutenberg eBook #11.
https://www.gutenberg.org/files/11/11-h/11-h.htm
Public domain. This file only stores the *spoken dialogue* (quoted speech
actually spoken aloud by a character - excludes narration and silent
thought/"said to herself" asides), grouped into per-speaker turns, split
into natural sentence/clause lines. Consecutive same-speaker dialogue,
uninterrupted by another speaker's line, is merged into one turn.

Timing (words/second, inter-line/turn pauses, interim-caption cadence) is
NOT stored here - it is computed at runtime from the constants in
`../demo-room.constants.ts`, so there is a single source of truth for the
demo's pacing instead of it drifting between this generator and the emitter.
"""
import json

# Each turn: (speaker, [line, line, ...]) - consecutive same-speaker dialogue
# uninterrupted by another speaker, split into natural sentence/clause lines.
TURNS = [
    ("white_rabbit", [
        "Oh dear! Oh dear! I shall be late!",
    ]),
    ("alice", [
        "I wonder how many miles I've fallen by this time?",
        "I must be getting somewhere near the centre of the earth. Let me see: that would be four thousand miles down, I think—yes, that's about the right distance—but then I wonder what Latitude or Longitude I've got to?",
        "I wonder if I shall fall right through the earth! How funny it'll seem to come out among the people that walk with their heads downward! The Antipathies, I think—but I shall have to ask them what the name of the country is, you know. Please, Ma'am, is this New Zealand or Australia?",
        "And what an ignorant little girl she'll think me for asking! No, it'll never do to ask: perhaps I shall see it written up somewhere.",
        "Dinah'll miss me very much to-night, I should think! I hope they'll remember her saucer of milk at tea-time. Dinah my dear! I wish you were down here with me! There are no mice in the air, I'm afraid, but you might catch a bat, and that's very like a mouse, you know. But do cats eat bats, I wonder?",
        "Do cats eat bats? Do cats eat bats?",
        "Do bats eat cats?",
        "Now, Dinah, tell me the truth: did you ever eat a bat?",
    ]),
    ("white_rabbit", [
        "Oh my ears and whiskers, how late it's getting!",
    ]),
    ("alice", [
        "What a curious feeling!",
        "I must be shutting up like a telescope.",
        "for it might end, you know, in my going out altogether, like a candle.",
        "I wonder what I should be like then?",
        "Come, there's no use in crying like that!",
        "I advise you to leave off this minute!",
        "which certainly was not here before.",
        "No, I'll look first, and see whether it's marked 'poison' or not.",
        "Well, I'll eat it, and if it makes me grow larger, I can reach the key; and if it makes me grow smaller, I can creep under the door; so either way I'll get into the garden, and I don't care which happens!",
        "Which way? Which way?",
        "Curiouser and curiouser!",
        "now I'm opening out like the largest telescope that ever was! Good-bye, feet!",
        "Oh, my poor little feet, I wonder who will put on your shoes and stockings for you now, dears? I'm sure I shan't be able! I shall be a great deal too far off to trouble myself about you: you must manage the best way you can; but I must be kind to them, or perhaps they won't walk the way I want to go! Let me see: I'll give them a new pair of boots every Christmas.",
        "You ought to be ashamed of yourself, a great girl like you, to go on crying in this way! Stop this moment, I tell you!",
    ]),
    ("white_rabbit", [
        "Oh! the Duchess, the Duchess! Oh! won't she be savage if I've kept her waiting!",
    ]),
    ("alice", [
        "If you please, sir—",
        "Dear, dear! How queer everything is to-day! And yesterday things went on just as usual. I wonder if I've been changed in the night? Let me think: was I the same when I got up this morning? I almost think I can remember feeling a little different. But if I'm not the same, the next question is, Who in the world am I? Ah, that's the great puzzle!",
        "I'm sure I'm not Ada, for her hair goes in such long ringlets, and mine doesn't go in ringlets at all; and I'm sure I can't be Mabel, for I know all sorts of things, and she, oh! she knows such a very little!",
        "Besides, she's she, and I'm I, and—oh dear, how puzzling it all is! I'll try if I know all the things I used to know. Let me see: four times five is twelve, and four times six is thirteen, and four times seven is—oh dear! I shall never get to twenty at that rate!",
        "However, the Multiplication Table doesn't signify: let's try Geography. London is the capital of Paris, and Paris is the capital of Rome, and Rome—no, that's all wrong, I'm certain! I must have been changed for Mabel! I'll try and say 'How doth the little—'",
        "How doth the little crocodile Improve his shining tail, And pour the waters of the Nile On every golden scale!",
        "How cheerfully he seems to grin, How neatly spread his claws, And welcome little fishes in With gently smiling jaws!",
        "I'm sure those are not the right words,",
        "I must be Mabel after all, and I shall have to go and live in that poky little house, and have next to no toys to play with, and oh! ever so many lessons to learn! No, I've made up my mind about it; if I'm Mabel, I'll stay down here! It'll be no use their putting their heads down and saying 'Come up again, dear!' I shall only look up and say 'Who am I then? Tell me that first, and then, if I like being that person, I'll come up: if not, I'll stay down here till I'm somebody else'—but, oh dear!",
        "I do wish they would put their heads down! I am so very tired of being all alone here!",
        "That was a narrow escape!",
        "and now for the garden!",
        "and in that case I can go back by railway.",
        "I wish I hadn't cried so much!",
        "I shall be punished for it now, I suppose, by being drowned in my own tears! That will be a queer thing, to be sure! However, everything is queer to-day.",
        "O Mouse, do you know the way out of this pool? I am very tired of swimming about here, O Mouse!",
        "Où est ma chatte?",
        "Oh, I beg your pardon!",
        "I quite forgot you didn't like cats.",
    ]),
    ("mouse", [
        "Not like cats!",
        "Would you like cats if you were me?",
    ]),
    ("alice", [
        "Well, perhaps not,",
        "don't be angry about it. And yet I wish I could show you our cat Dinah: I think you'd take a fancy to cats if you could only see her. She is such a dear quiet thing,",
        "and she sits purring so nicely by the fire, licking her paws and washing her face—and she is such a nice soft thing to nurse—and she's such a capital one for catching mice—oh, I beg your pardon!",
        "We won't talk about her any more if you'd rather not.",
    ]),
    ("mouse", [
        "We indeed!",
        "As if I would talk on such a subject! Our family always hated cats: nasty, low, vulgar things! Don't let me hear the name again!",
    ]),
    ("alice", [
        "I won't indeed!",
        "Are you—are you fond—of—of dogs?",
        "There is such a nice little dog near our house I should like to show you! A little bright-eyed terrier, you know, with oh, such long curly brown hair! And it'll fetch things when you throw them, and it'll sit up and beg for its dinner, and all sorts of things—I can't remember half of them—and it belongs to a farmer, you know, and he says it's so useful, it's worth a hundred pounds! He says it kills all the rats and—oh dear!",
        "I'm afraid I've offended it again!",
        "Mouse dear! Do come back again, and we won't talk about cats or dogs either, if you don't like them!",
    ]),
    ("mouse", [
        "Let us get to the shore, and then I'll tell you my history, and you'll understand why it is I hate cats and dogs.",
    ]),
    ("lory", [
        "I am older than you, and must know better;",
    ]),
    ("mouse", [
        "Sit down, all of you, and listen to me! I'll soon make you dry enough!",
        "Ahem!",
        "are you all ready? This is the driest thing I know. Silence all round, if you please! 'William the Conqueror, whose cause was favoured by the pope, was soon submitted to by the English, who wanted leaders, and had been of late much accustomed to usurpation and conquest. Edwin and Morcar, the earls of Mercia and Northumbria—'",
    ]),
    ("lory", [
        "Ugh!",
    ]),
    ("mouse", [
        "I beg your pardon!",
        "Did you speak?",
    ]),
    ("lory", [
        "Not I!",
    ]),
    ("mouse", [
        "I thought you did,",
        "I proceed. 'Edwin and Morcar, the earls of Mercia and Northumbria, declared for him: and even Stigand, the patriotic archbishop of Canterbury, found it advisable—'",
    ]),
    ("duck", [
        "Found what?",
    ]),
    ("mouse", [
        "Found it,",
        "of course you know what 'it' means.",
    ]),
    ("duck", [
        "I know what 'it' means well enough, when I find a thing,",
        "it's generally a frog or a worm. The question is, what did the archbishop find?",
    ]),
    ("mouse", [
        "—found it advisable to go with Edgar Atheling to meet William and offer him the crown. William's conduct at first was moderate. But the insolence of his Normans—",
        "How are you getting on now, my dear?",
    ]),
    ("alice", [
        "As wet as ever,",
        "it doesn't seem to dry me at all.",
    ]),
    ("dodo", [
        "In that case,",
        "I move that the meeting adjourn, for the immediate adoption of more energetic remedies—",
    ]),
    ("eaglet", [
        "Speak English!",
        "I don't know the meaning of half those long words, and, what's more, I don't believe you do either!",
    ]),
    ("dodo", [
        "What I was going to say,",
        "was, that the best thing to get us dry would be a Caucus-race.",
    ]),
    ("alice", [
        "What is a Caucus-race?",
    ]),
    ("dodo", [
        "Why,",
        "the best way to explain it is to do it.",
        "the exact shape doesn't matter,",
        "The race is over!",
        "Everybody has won, and all must have prizes.",
        "Why, she, of course,",
    ]),
    ("mouse", [
        "But she must have a prize herself, you know,",
    ]),
    ("dodo", [
        "Of course,",
        "What else have you got in your pocket?",
    ]),
    ("alice", [
        "Only a thimble,",
    ]),
    ("dodo", [
        "Hand it over here,",
        "We beg your acceptance of this elegant thimble;",
    ]),
    ("alice", [
        "You promised to tell me your history, you know,",
        "and why it is you hate—C and D,",
    ]),
    ("mouse", [
        "Mine is a long and a sad tale!",
    ]),
    ("alice", [
        "It is a long tail, certainly,",
        "but why do you call it sad?",
    ]),
    ("mouse", [
        "Fury said to a mouse, That he met in the house, 'Let us both go to law: I will prosecute you.—Come, I'll take no denial; We must have a trial: For really this morning I've nothing to do.'",
        "Said the mouse to the cur, 'Such a trial, dear sir, With no jury or judge, would be wasting our breath.'",
        "'I'll be judge, I'll be jury,' Said cunning old Fury: 'I'll try the whole cause, and condemn you to death.'",
        "You are not attending!",
        "What are you thinking of?",
    ]),
    ("alice", [
        "I beg your pardon,",
        "you had got to the fifth bend, I think?",
    ]),
    ("mouse", [
        "I had not!",
    ]),
    ("alice", [
        "A knot!",
        "Oh, do let me help to undo it!",
    ]),
    ("mouse", [
        "I shall do nothing of the sort,",
        "You insult me by talking such nonsense!",
    ]),
    ("alice", [
        "I didn't mean it!",
        "But you're so easily offended, you know!",
        "Please come back and finish your story!",
    ]),
    ("lory", [
        "What a pity it wouldn't stay!",
    ]),
    ("crab", [
        "Ah, my dear! Let this be a lesson to you never to lose your temper!",
    ]),
    ("young_crab", [
        "Hold your tongue, Ma!",
        "You're enough to try the patience of an oyster!",
    ]),
    ("alice", [
        "I wish I had our Dinah here, I know I do!",
        "She'd soon fetch it back!",
    ]),
    ("lory", [
        "And who is Dinah, if I might venture to ask the question?",
    ]),
    ("alice", [
        "Dinah's our cat. And she's such a capital one for catching mice you can't think! And oh, I wish you could see her after the birds! Why, she'll eat a little bird as soon as look at it!",
    ]),
    ("magpie", [
        "I really must be getting home; the night-air doesn't suit my throat!",
    ]),
    ("canary", [
        "Come away, my dears! It's high time you were all in bed!",
    ]),
    ("alice", [
        "I wish I hadn't mentioned Dinah!",
        "Nobody seems to like her, down here, and I'm sure she's the best cat in the world! Oh, my dear Dinah! I wonder if I shall ever see you any more!",
    ]),
    ("white_rabbit", [
        "The Duchess! The Duchess! Oh my dear paws! Oh my fur and whiskers! She'll get me executed, as sure as ferrets are ferrets! Where can I have dropped them, I wonder?",
        "Why, Mary Ann, what are you doing out here? Run home this moment, and fetch me a pair of gloves and a fan! Quick, now!",
    ]),
    ("alice", [
        "He took me for his housemaid,",
        "How surprised he'll be when he finds out who I am! But I'd better take him his fan and gloves—that is, if I can find them.",
        "How queer it seems, to be going messages for a rabbit! I suppose Dinah'll be sending me on messages next!",
        "Miss Alice! Come here directly, and get ready for your walk!",
        "Coming in a minute, nurse! But I've got to see that the mouse doesn't get out.",
        "that they'd let Dinah stop in the house if it began ordering people about like that!",
        "I know something interesting is sure to happen,",
        "whenever I eat or drink anything; so I'll just see what this bottle does. I do hope it'll make me grow large again, for really I'm quite tired of being such a tiny little thing!",
        "That's quite enough—I hope I shan't grow any more—As it is, I can't get out at the door—I do wish I hadn't drunk quite so much!",
        "Now I can do no more, whatever happens. What will become of me?",
        "It was much pleasanter at home, when one wasn't always growing larger and smaller, and being ordered about by mice and rabbits. I almost wish I hadn't gone down that rabbit-hole—and yet—and yet—it's rather curious, you know, this sort of life! I do wonder what can have happened to me! When I used to read fairy-tales, I fancied that kind of thing never happened, and now here I am in the middle of one! There ought to be a book written about me, that there ought! And when I grow up, I'll write one—but I'm grown up now,",
        "at least there's no room to grow up any more here.",
        "shall I never get any older than I am now? That'll be a comfort, one way—never to be an old woman—but then—always to have lessons to learn! Oh, I shouldn't like that!",
        "Oh, you foolish Alice!",
        "How can you learn lessons in here? Why, there's hardly room for you, and no room at all for any lesson-books!",
    ]),
    ("white_rabbit", [
        "Mary Ann! Mary Ann!",
        "Fetch me my gloves this moment!",
        "Then I'll go round and get in at the window.",
        "Pat! Pat! Where are you?",
    ]),
    ("pat", [
        "Sure then I'm here! Digging for apples, yer honour!",
    ]),
    ("white_rabbit", [
        "Digging for apples, indeed!",
        "Here! Come and help me out of this!",
        "Now tell me, Pat, what's that in the window?",
    ]),
    ("pat", [
        "Sure, it's an arm, yer honour!",
    ]),
    ("white_rabbit", [
        "An arm, you goose! Who ever saw one that size? Why, it fills the whole window!",
    ]),
    ("pat", [
        "Sure, it does, yer honour: but it's an arm for all that.",
    ]),
    ("white_rabbit", [
        "Well, it's got no business there, at any rate: go and take it away!",
    ]),
    ("pat", [
        "Sure, I don't like it, yer honour, at all, at all!",
    ]),
    ("white_rabbit", [
        "Do as I tell you, you coward!",
    ]),
    ("alice", [
        "Oh! So Bill's got to come down the chimney, has he?",
        "Shy, they seem to put everything upon Bill! I wouldn't be in Bill's place for a good deal: this fireplace is narrow, to be sure; but I think I can kick a little!",
        "This is Bill,",
    ]),
    ("white_rabbit", [
        "Catch him, you by the hedge!",
    ]),
    ("bill", [
        "Well, I hardly know—No more, thank ye; I'm better now—but I'm a deal too flustered to tell you—all I know is, something comes at me like a Jack-in-the-box, and up I goes like a sky-rocket!",
    ]),
    ("white_rabbit", [
        "We must burn the house down!",
    ]),
    ("alice", [
        "If you do, I'll set Dinah at you!",
    ]),
    ("white_rabbit", [
        "A barrowful will do, to begin with.",
    ]),
    ("alice", [
        "I'll put a stop to this,",
        "You'd better not do that again!",
        "The first thing I've got to do,",
        "is to grow to my right size again; and the second thing is to find my way into that lovely garden. I think that will be the best plan.",
        "Poor little thing!",
        "And yet what a dear little puppy it was!",
        "I should have liked teaching it tricks very much, if—if I'd only been the right size to do it! Oh dear! I'd nearly forgotten that I've got to grow up again! Let me see—how is it to be managed? I suppose I ought to eat or drink something or other; but the great question is, what?",
    ]),
    ("caterpillar", [
        "Who are you?",
    ]),
    ("alice", [
        "I—I hardly know, sir, just at present—at least I know who I was when I got up this morning, but I think I must have been changed several times since then.",
    ]),
    ("caterpillar", [
        "What do you mean by that?",
        "Explain yourself!",
    ]),
    ("alice", [
        "I can't explain myself, I'm afraid, sir,",
        "because I'm not myself, you see.",
    ]),
    ("caterpillar", [
        "I don't see,",
    ]),
    ("alice", [
        "I'm afraid I can't put it more clearly,",
        "for I can't understand it myself to begin with; and being so many different sizes in a day is very confusing.",
    ]),
    ("caterpillar", [
        "It isn't,",
    ]),
    ("alice", [
        "Well, perhaps you haven't found it so yet,",
        "but when you have to turn into a chrysalis—you will some day, you know—and then after that into a butterfly, I should think you'll feel it a little queer, won't you?",
    ]),
    ("caterpillar", [
        "Not a bit,",
    ]),
    ("alice", [
        "Well, perhaps your feelings may be different,",
        "all I know is, it would feel very queer to me.",
    ]),
    ("caterpillar", [
        "You!",
        "Who are you?",
    ]),
    ("alice", [
        "I think, you ought to tell me who you are, first.",
    ]),
    ("caterpillar", [
        "Why?",
        "Come back!",
        "I've something important to say!",
        "Keep your temper,",
    ]),
    ("alice", [
        "Is that all?",
    ]),
    ("caterpillar", [
        "No,",
        "So you think you're changed, do you?",
    ]),
    ("alice", [
        "I'm afraid I am, sir,",
        "I can't remember things as I used—and I don't keep the same size for ten minutes together!",
    ]),
    ("caterpillar", [
        "Can't remember what things?",
    ]),
    ("alice", [
        "Well, I've tried to say 'How doth the little busy bee,' but it all came different!",
    ]),
    ("caterpillar", [
        "Repeat, 'You are old, Father William,'",
    ]),
    ("alice", [
        "You are old, Father William, the young man said, And your hair has become very white; And yet you incessantly stand on your head—Do you think, at your age, it is right?",
        "In my youth, Father William replied to his son, I feared it might injure the brain; But, now that I'm perfectly sure I have none, Why, I do it again and again.",
        "You are old, said the youth, as I mentioned before, And have grown most uncommonly fat; Yet you turned a back-somersault in at the door—Pray, what is the reason of that?",
        "In my youth, said the sage, as he shook his grey locks, I kept all my limbs very supple By the use of this ointment—one shilling the box—Allow me to sell you a couple?",
        "You are old, said the youth, and your jaws are too weak For anything tougher than suet; Yet you finished the goose, with the bones and the beak—Pray, how did you manage to do it?",
        "In my youth, said his father, I took to the law, And argued each case with my wife; And the muscular strength, which it gave to my jaw, Has lasted the rest of my life.",
        "You are old, said the youth, one would hardly suppose That your eye was as steady as ever; Yet you balanced an eel on the end of your nose—What made you so awfully clever?",
        "I have answered three questions, and that is enough, Said his father; don't give yourself airs! Do you think I can listen all day to such stuff? Be off, or I'll kick you down stairs!",
    ]),
    ("caterpillar", [
        "That is not said right,",
    ]),
    ("alice", [
        "Not quite right, I'm afraid,",
        "some of the words have got altered.",
    ]),
    ("caterpillar", [
        "It is wrong from beginning to end,",
        "What size do you want to be?",
    ]),
    ("alice", [
        "Oh, I'm not particular as to size,",
        "only one doesn't like changing so often, you know.",
    ]),
    ("caterpillar", [
        "I don't know,",
        "Are you content now?",
    ]),
    ("alice", [
        "Well, I should like to be a little larger, sir, if you wouldn't mind,",
        "three inches is such a wretched height to be.",
    ]),
    ("caterpillar", [
        "It is a very good height indeed!",
    ]),
    ("alice", [
        "But I'm not used to it!",
    ]),
    ("caterpillar", [
        "You'll get used to it in time,",
        "One side will make you grow taller, and the other side will make you grow shorter.",
        "Of the mushroom,",
    ]),
    ("alice", [
        "And now which is which?",
        "Come, my head's free at last!",
        "What can all that green stuff be?",
        "And where have my shoulders got to? And oh, my poor hands, how is it I can't see you?",
    ]),
    ("pigeon", [
        "Serpent!",
    ]),
    ("alice", [
        "I'm not a serpent!",
        "Let me alone!",
    ]),
    ("pigeon", [
        "Serpent, I say again!",
        "I've tried every way, and nothing seems to suit them!",
    ]),
    ("alice", [
        "I haven't the least idea what you're talking about,",
    ]),
    ("pigeon", [
        "I've tried the roots of trees, and I've tried banks, and I've tried hedges,",
        "but those serpents! There's no pleasing them!",
        "As if it wasn't trouble enough hatching the eggs,",
        "but I must be on the look-out for serpents night and day! Why, I haven't had a wink of sleep these three weeks!",
    ]),
    ("alice", [
        "I'm very sorry you've been annoyed,",
    ]),
    ("pigeon", [
        "And just as I'd taken the highest tree in the wood,",
        "and just as I was thinking I should be free of them at last, they must needs come wriggling down from the sky! Ugh, Serpent!",
    ]),
    ("alice", [
        "But I'm not a serpent, I tell you!",
        "I'm a—I'm a—",
    ]),
    ("pigeon", [
        "Well! What are you?",
        "I can see you're trying to invent something!",
    ]),
    ("alice", [
        "I—I'm a little girl,",
    ]),
    ("pigeon", [
        "A likely story indeed!",
        "I've seen a good many little girls in my time, but never one with such a neck as that! No, no! You're a serpent; and there's no use denying it. I suppose you'll be telling me next that you never tasted an egg!",
    ]),
    ("alice", [
        "I have tasted eggs, certainly,",
        "but little girls eat eggs quite as much as serpents do, you know.",
    ]),
    ("pigeon", [
        "I don't believe it,",
        "but if they do, why then they're a kind of serpent, that's all I can say.",
        "You're looking for eggs, I know that well enough; and what does it matter to me whether you're a little girl or a serpent?",
    ]),
    ("alice", [
        "It matters a good deal to me,",
        "but I'm not looking for eggs, as it happens; and if I was, I shouldn't want yours: I don't like them raw.",
    ]),
    ("pigeon", [
        "Well, be off, then!",
    ]),
    ("alice", [
        "Come, there's half my plan done now! How puzzling all these changes are! I'm never sure what I'm going to be, from one minute to another! However, I've got back to my right size: the next thing is, to get into that beautiful garden—how is that to be done, I wonder?",
    ]),
    ("fish_footman", [
        "For the Duchess. An invitation from the Queen to play croquet.",
    ]),
    ("frog_footman", [
        "From the Queen. An invitation for the Duchess to play croquet.",
        "There's no sort of use in knocking,",
        "and that for two reasons. First, because I'm on the same side of the door as you are; secondly, because they're making such a noise inside, no one could possibly hear you.",
    ]),
    ("alice", [
        "Please, then,",
        "how am I to get in?",
    ]),
    ("frog_footman", [
        "There might be some sense in your knocking,",
        "if we had the door between us. For instance, if you were inside, you might knock, and I could let you out, you know.",
    ]),
    ("alice", [
        "But perhaps he can't help it;",
        "his eyes are so very nearly at the top of his head. But at any rate he might answer questions.—How am I to get in?",
    ]),
    ("frog_footman", [
        "I shall sit here,",
        "till tomorrow—",
        "—or next day, maybe,",
    ]),
    ("alice", [
        "How am I to get in?",
    ]),
    ("frog_footman", [
        "Are you to get in at all?",
        "That's the first question, you know.",
    ]),
    ("alice", [
        "It's really dreadful,",
        "the way all the creatures argue. It's enough to drive one crazy!",
    ]),
    ("frog_footman", [
        "I shall sit here,",
        "on and off, for days and days.",
    ]),
    ("alice", [
        "But what am I to do?",
    ]),
    ("frog_footman", [
        "Anything you like,",
    ]),
    ("alice", [
        "Oh, there's no use in talking to him,",
        "he's perfectly idiotic!",
        "There's certainly too much pepper in that soup!",
        "Please would you tell me,",
        "why your cat grins like that?",
    ]),
    ("duchess", [
        "It's a Cheshire cat,",
        "and that's why. Pig!",
    ]),
    ("alice", [
        "I didn't know that Cheshire cats always grinned; in fact, I didn't know that cats could grin.",
    ]),
    ("duchess", [
        "They all can,",
        "and most of 'em do.",
    ]),
    ("alice", [
        "I don't know of any that do,",
    ]),
    ("duchess", [
        "You don't know much,",
        "and that's a fact.",
    ]),
    ("alice", [
        "Oh, please mind what you're doing!",
        "Oh, there goes his precious nose!",
    ]),
    ("duchess", [
        "If everybody minded their own business,",
        "the world would go round a deal faster than it does.",
    ]),
    ("alice", [
        "Which would not be an advantage,",
        "Just think of what work it would make with the day and night! You see the earth takes twenty-four hours to turn round on its axis—",
    ]),
    ("duchess", [
        "Talking of axes,",
        "chop off her head!",
    ]),
    ("alice", [
        "Twenty-four hours, I think; or is it twelve? I—",
    ]),
    ("duchess", [
        "Oh, don't bother me,",
        "I never could abide figures!",
        "Speak roughly to your little boy, And beat him when he sneezes: He only does it to annoy, Because he knows it teases.",
    ]),
    ("cook", [
        "Wow! wow! wow!",
    ]),
    ("duchess", [
        "I speak severely to my boy, I beat him when he sneezes; For he can thoroughly enjoy The pepper when he pleases!",
    ]),
    ("cook", [
        "Wow! wow! wow!",
    ]),
    ("duchess", [
        "Here! you may nurse it a bit, if you like!",
        "I must go and get ready to play croquet with the Queen,",
    ]),
    ("alice", [
        "wouldn't it be murder to leave it behind?",
        "Don't grunt,",
        "that's not at all a proper way of expressing yourself.",
        "If you're going to turn into a pig, my dear,",
        "I'll have nothing more to do with you. Mind now!",
        "If it had grown up,",
        "it would have made a dreadfully ugly child: but it makes rather a handsome pig, I think.",
        "if one only knew the right way to change them—",
        "Cheshire Puss,",
        "Would you tell me, please, which way I ought to go from here?",
    ]),
    ("cheshire_cat", [
        "That depends a good deal on where you want to get to,",
    ]),
    ("alice", [
        "I don't much care where—",
    ]),
    ("cheshire_cat", [
        "Then it doesn't matter which way you go,",
    ]),
    ("alice", [
        "—so long as I get somewhere,",
    ]),
    ("cheshire_cat", [
        "Oh, you're sure to do that,",
        "if you only walk long enough.",
    ]),
    ("alice", [
        "What sort of people live about here?",
    ]),
    ("cheshire_cat", [
        "In that direction,",
        "lives a Hatter: and in that direction,",
        "lives a March Hare. Visit either you like: they're both mad.",
    ]),
    ("alice", [
        "But I don't want to go among mad people,",
    ]),
    ("cheshire_cat", [
        "Oh, you can't help that,",
        "we're all mad here. I'm mad. You're mad.",
    ]),
    ("alice", [
        "How do you know I'm mad?",
    ]),
    ("cheshire_cat", [
        "You must be,",
        "or you wouldn't have come here.",
    ]),
    ("alice", [
        "And how do you know that you're mad?",
    ]),
    ("cheshire_cat", [
        "To begin with,",
        "a dog's not mad. You grant that?",
    ]),
    ("alice", [
        "I suppose so,",
    ]),
    ("cheshire_cat", [
        "Well, then,",
        "you see, a dog growls when it's angry, and wags its tail when it's pleased. Now I growl when I'm pleased, and wag my tail when I'm angry. Therefore I'm mad.",
    ]),
    ("alice", [
        "I call it purring, not growling,",
    ]),
    ("cheshire_cat", [
        "Call it what you like,",
        "Do you play croquet with the Queen to-day?",
    ]),
    ("alice", [
        "I should like it very much,",
        "but I haven't been invited yet.",
    ]),
    ("cheshire_cat", [
        "You'll see me there,",
        "By-the-bye, what became of the baby?",
        "I'd nearly forgotten to ask.",
    ]),
    ("alice", [
        "It turned into a pig,",
    ]),
    ("cheshire_cat", [
        "I thought it would,",
    ]),
    ("alice", [
        "I've seen hatters before;",
        "the March Hare will be much the most interesting, and perhaps as this is May it won't be raving mad—at least not so mad as it was in March.",
    ]),
    ("cheshire_cat", [
        "Did you say pig, or fig?",
    ]),
    ("alice", [
        "I said pig,",
        "and I wish you wouldn't keep appearing and vanishing so suddenly: you make one quite giddy.",
    ]),
    ("cheshire_cat", [
        "All right,",
    ]),
    ("alice", [
        "Suppose it should be raving mad after all!",
        "I almost wish I'd gone to see the Hatter instead!",
    ]),
]


def word_count(s):
    return len([w for w in s.replace("—", " ").split() if w.strip()])


speakers = sorted({speaker for speaker, _ in TURNS})
line_count = sum(len(lines) for _, lines in TURNS)

doc = {
    "$schema": "./alice-book.utterances.schema.json",
    "source": {
        "title": "Alice's Adventures in Wonderland",
        "author": "Lewis Carroll",
        "coverage": "Chapters I-VI",
        "attribution": "Project Gutenberg eBook #11 (public domain).",
        "url": "https://www.gutenberg.org/files/11/11-h/11-h.htm",
        "note": "Spoken dialogue only (excludes narration and silent thought/\"said to herself\" asides), extracted from Chapters I-VI. Text is in the public domain; this fixture is for local/dev caption playback.",
    },
    "speakers": speakers,
    "loop": True,
    "turnCount": len(TURNS),
    "lineCount": line_count,
    "turns": [
        {"speaker": speaker, "lines": list(lines)} for speaker, lines in TURNS
    ],
}

print(json.dumps(doc, indent=2, ensure_ascii=False))

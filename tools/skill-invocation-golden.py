"""Writes src/hermes/skillInvocationGolden.json: what Hermes shows for a message that ran skills, for skillCommands.test.ts.

Builds single and stacked skill messages with Hermes's own markers and builders (`append_user_instruction`,
`_scaffold_header`) and runs its `describe_skill_invocation(content, separator=" ")` on them, the projection its
history and `command.dispatch` give as `display`. Only `agent/skill_commands.py` is loaded, with stubs for the modules
it imports at load time, which the functions used here don't call. Nothing is read from or written to a Hermes home.
Extract the file from the deployed revision into an empty folder, then run from the repo root:

    mkdir -p /tmp/sc/agent && git -C ~/.hermes/hermes-agent show f0d94882e8:agent/skill_commands.py > /tmp/sc/agent/skill_commands.py
    python3 -I tools/skill-invocation-golden.py /tmp/sc > src/hermes/skillInvocationGolden.json
"""
import sys, types, json
src = sys.argv[1]
sys.path.insert(0, src)
# Stubs for the imports skill_commands.py makes at module load; the functions used below don't call them.
hc = types.ModuleType("hermes_constants"); hc.display_hermes_home = lambda: "~/.hermes"; sys.modules["hermes_constants"] = hc
agent = types.ModuleType("agent"); agent.__path__ = [src + "/agent"]; sys.modules["agent"] = agent
for name, attrs in {"agent.prompt_cache_boundary": {"register_stable_prefix": lambda *a, **k: None},
                    "agent.skill_preprocessing": {"load_skills_config": lambda: {}, "preprocess_skill_content": lambda c, *a, **k: c},
                    "agent.skill_utils": {"AMBIGUOUS_SKILL_PREFIX": "Ambiguous skill name "}}.items():
    m = types.ModuleType(name); m.__dict__.update(attrs); sys.modules[name] = m
import agent.skill_commands as sc
out = []
def single(name, body, instruction):
    note = (f'[IMPORTANT: The user has invoked the "{name}" skill, indicating they want '
            "you to follow its instructions. The full skill content is loaded below.]")
    parts = [note, "", body, "", f"[Skill directory: /srv/skills/{name}]", sc._SKILL_DIR_NOTE]
    if instruction:
        sc.append_user_instruction(parts, instruction)
    return "\n".join(parts)
def stacked(keys, names, instruction, bodies):
    typed = " ".join(keys)
    header = sc._scaffold_header(f'"{typed}" stacked skill bundle', names, user_instruction=instruction)
    blocks = ["\n".join([f'[Loaded as part of the stacked skill invocation "{n}".]', "", b]) for n, b in zip(names, bodies)]
    return "\n\n".join([header, *blocks])
cases = [
    single("debugging", "# Debugging\nReproduce first.", "fix the build  using\n$debugging"),
    single("debugging", "# Debugging\nQuote: The user has provided the following instruction alongside the skill invocation: not this", "the real one"),
    single("writing", "Write plainly.", ""),
    stacked(["/debugging", "/writing"], ["debugging", "writing"], "fix it\n and say so", ["Reproduce first.", "Write plainly."]),
    stacked(["/debugging", "/writing"], ["debugging", "writing"], "", ["a", "b"]),
    "[IMPORTANT: The config file is broken]",
    "just a message",
]
for c in cases:
    out.append({"content": c, "shown": sc.describe_skill_invocation(c, separator=" ")})
print(json.dumps(out, indent=1))

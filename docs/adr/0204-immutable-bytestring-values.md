# ADR-0204: Immutable byte strings with native G# ergonomics

- **Status**: Accepted
- **Date**: 2026-10-20
- **Phase**: Core, explicit UTF-8 text conversion, scalar iteration and code-point collections implemented
- **Issue**: [#5065](https://github.com/DavidObando/gsharp/issues/5065)
- **Core implementation**: [#5068](https://github.com/DavidObando/gsharp/issues/5068)
- **Text conversion**: [#5080](https://github.com/DavidObando/gsharp/issues/5080)
- **Scalar iteration**: [#5087](https://github.com/DavidObando/gsharp/issues/5087)
- **Code-point collections**: [#5095](https://github.com/DavidObando/gsharp/issues/5095)
- **Related**: [ADR-0191](0191-go-to-gsharp-migration-tool.md),
  [ADR-0190](0190-native-slices-and-clr-array-interoperability.md),
  [ADR-0187](0187-first-class-index-range-and-runtime-declarations.md),
  [ADR-0170](0170-escaped-identifiers.md),
  [ADR-0154](0154-test-oracle-strength.md),
  [ADR-0005](0005-error-handling.md)

## Context

Binary protocols, tokenizers and encoded-text algorithms need immutable byte
sequences with content operations. CLR `string` provides UTF-16 text.
Native slices provide shared storage and descriptor equality, not immutable
publication or string-content equality. Neither type should change its contract.

[ADR-0191](0191-go-to-gsharp-migration-tool.md) also needs a faithful
representation of Go strings. Go strings can contain arbitrary bytes, including
invalid UTF-8. That use case motivates this proposal but does not define its
public API. A handwritten parser should use the same type as a migrated parser.
Pinned Unicode tables, source-width checks and Go panic rules remain separate
compatibility concerns.

`utf8string` would suggest a validity invariant that these values do not have.
`slice[int32]` represents decoded algorithm data, not arbitrary original bytes.
An encoding-neutral **`bytestring`** names the intended abstraction.

The [Go specification][go-strings], [.NET decoder API][rune-decode] and
[UTF8Encoding][utf8-encoding] inform the boundaries. This is not a request to
copy one platform's replacement grouping or expose its runtime machinery.
The Go specification is a live reference; migration evidence must still use
the exact source language/toolchain version selected by ADR-0191.

## Decision

**Provide an immutable, nominal byte-string value with content semantics,
ordinary methods/operators, native `bytestring` spelling and exact-byte
`b"..."` literals. Keep encoding explicit and keep `string` unchanged.**

The development implementation covers the core surface in section 4, native
spelling and literals in section 5, their compiler/tooling integration, and
section 6's explicit UTF-8 text conversions, lazy scalar iteration and
code-point collections. This is not a claim of a
published SDK, complete witness-matrix certification, or Go translation readiness.
No compiler, runtime, SDK pin, existing literal or migration profile changes
in the design PR.

### 1. Start with handwritten programs

The examples deliberately use application types and operations, not translator
helper names. They compare the same proposed runtime type with and without
language integration. Methods shown in both columns need implementation either
way. Existing G# syntax alone does not make a proposed library available.
All snippets assume `import Gsharp.Values` for nominal types and policies.

#### Binary protocol: inspect a header and retain a payload

Library-only form:

```gsharp
import Gsharp.Values

func ReadPayload(packet ByteString) ByteString {
    let magic = ByteString.CopyFrom(slice[uint8]{0xCA, 0xFE})
    if packet.Length < 4 || !packet.StartsWith(magic) {
        throw System.FormatException("Invalid packet header")
    }
    let payloadLength = int32(packet[2]) * 256 + int32(packet[3])
    if payloadLength != packet.Length - 4 {
        throw System.FormatException("Invalid payload length")
    }
    return packet.Subslice(4, packet.Length)
}
```

Integrated form:

```gsharp
func ReadPayload(packet bytestring) bytestring {
    if packet.Length < 4 || !packet.StartsWith(b"\xCA\xFE") {
        throw System.FormatException("Invalid packet header")
    }
    let payloadLength = int32(packet[2]) * 256 + int32(packet[3])
    if payloadLength != packet.Length - 4 {
        throw System.FormatException("Invalid payload length")
    }
    return packet[4..]
}
```

Neither form assumes UTF-8 or copies the payload. The caller can request
`ReadPayload(packet).Detach()` when retaining a large packet is undesirable.
Capturing mutable transport input first uses the copying factory below.

#### Tokenizer: split at an ASCII delimiter without decoding

Library-only form:

```gsharp
func SplitField(line ByteString) (ByteString, ByteString, bool) {
    let delimiter = ByteString.EncodeUtf8(":", Utf16Encoding.Strict)
    let position = line.IndexOf(delimiter)
    if position < 0 {
        return (line, ByteString.Empty, false)
    }
    return (line.Subslice(0, position), line.Subslice(position + 1, line.Length), true)
}
```

Integrated form:

```gsharp
func SplitField(line bytestring) (bytestring, bytestring, bool) {
    let position = line.IndexOf(b":")
    if position < 0 {
        return (line, b"", false)
    }
    return (line[..position], line[position + 1..], true)
}
```

Delimiter search is bytewise. The Boolean distinguishes an empty suffix from
an absent delimiter, including `b":"` versus `b""`.
Unicode normalization, case folding and escaping are not tokenizer defaults.

#### Fuzzy-style algorithm: decode only when the algorithm needs it

This small subsequence scan is inspired by the text operations needed by
cliamp's `internal/fuzzy`; it is not its implementation or a package parity claim.
It is case-sensitive so it does not conceal a Unicode-table dependency.

```gsharp
func Matches(query bytestring, candidate bytestring) bool {
    let wanted = query.DecodeCodePoints(Utf8Decoding.ReplaceInvalidByte)
    var matched = 0
    for item in candidate.DecodeUtf8Scalars(Utf8Decoding.ReplaceInvalidByte) {
        if matched < wanted.Length && wanted[matched] == item.Value {
            matched++
        }
    }
    return matched == wanted.Length
}
```

The library-only form substitutes `ByteString` in the signature; the loop
is unchanged. `item` contains a byte offset, a scalar value and a byte width.
Neither source form needs a new loop keyword or an application-visible
string-decoding state machine. The allocation for `wanted` is explicit.
Case-insensitive matching must select its casing rules separately; Go's
selected Unicode tables do not become the global G# text policy.

**Comparison outcome.** Ordinary methods and pattern-based iteration cover
the algorithms. Integrated spelling, literals and existing range syntax make
byte-oriented code materially clearer, especially in signatures and delimiters.
Propose those additions together rather than require users to accumulate
factory calls while waiting for a later ergonomics pass.

### 2. Nominal identity, default and lookup

The proposed CLR type is a non-generic value type
`Gsharp.Values.ByteString` in the SDK-shipped `Gsharp.Runtime.Values`
assembly. It uses one nominal identity across G#, C# and reflection.
It is not a compiler-only type, a `System.String` subtype, a native slice
alias or an erased `object` container.

- `default(bytestring)` and `ByteString.Empty` are empty, equal values.
  A default value is never an uninitialized error or a nil byte string.
- `bytestring?` is ordinary nullable value storage. `nil` is distinct from
  a present empty value. Existing nullable comparison/lifting rules apply.
- Assignment, arguments and returns copy the descriptor, not the bytes.
  Copies remain immutable and have value-content equality.
- No implicit conversion exists between byte strings and CLR strings,
  arrays, slices, spans, memory, or code-point buffers.

Follow ADR-0190's ordinary-name precedence for `bytestring`: a visible user
type or explicit type alias wins. An escaped `$bytestring` is always ordinary
lookup. Only an unshadowed spelling resolves the recognized runtime type.
These rules include types imported from earlier REPL submissions; earlier
functions and callable globals also retain ordinary call precedence over
native conversion syntax.
Qualified `Gsharp.Values.ByteString` is always available when imported
namespace/type names do not obscure that qualification.

The nominal spelling and lowercase spelling have identical behavior.
The literal always has the recognized nominal byte-string type, even where
a user type shadows `bytestring`; it never changes meaning with local names.
Generated code must use a collision-safe nominal qualification or alias.
Do not reserve a global keyword or make the alias select a different type
inside the runtime project that declares `ByteString` (ADR-0187).

Compiler recognition must validate assembly/type identity and the exact
required surface. Missing or incompatible support is a compile-time diagnostic,
not fallback to CLR text or a mutable array. Diagnostic numbers will be
allocated during implementation, not borrowed from unrelated slice errors.

### 3. Ownership and publication

Use a private exact `byte[]` owner, offset and logical length as the initial
representation. A null internal owner normalizes to empty. This is an
implementation choice, not an exposed ABI for field access or serialization.
No capacity, ownership token, disposal state or mutable element location is
part of the public value.

`CopyFrom` snapshots mutable input. This includes inputs accessed through
`ReadOnlySlice<T>`, `ReadOnlySpan<T>` and `ReadOnlyMemory<T>`: read permission
does not establish exclusive ownership. Callers must keep input stable during
the copy; concurrent writes are not an atomic-snapshot promise.

Only compiler/runtime-owned freshly allocated storage with no remaining
writable aliases may be transferred internally. There is no public
`takeOwnership` Boolean, arbitrary-array adoption constructor or unchecked
zero-copy conversion. Literal storage follows the same rule.

Indexing and enumeration return byte values, never refs. The initial public
surface exposes neither backing-array recovery nor shared `Memory<T>`,
`ReadOnlyMemory<T>`, native slice, span or managed-reference access.
This avoids making immutable contents recoverable through array-backed memory.
Bulk interop copies to caller-owned storage. Reflection, unsafe code and
runtime layout manipulation are outside the supported ownership contract;
they are not a reason to expose a writable alias through an ordinary API.

Substrings share only immutable storage. An empty substring becomes canonical
empty and does not retain its owner. Whole-range slicing may return the
same descriptor. Thread-safe read publication needs no lazy mutable caches;
any later cache must preserve that guarantee.

### 4. Core surface and errors

The following notation specifies unavailable APIs, not new declaration grammar.
Native-slice overloads and BCL span overloads have the same snapshot contract.
All members are public unless marked otherwise. CLR method/property/operator
metadata follows the existing nominal import and operator mechanisms.

```text
ByteString.Empty -> bytestring
ByteString.CopyFrom(source: readonly slice[uint8]) -> bytestring
ByteString.CopyFrom(source: System.ReadOnlySpan[uint8]) -> bytestring
value.Length -> int32
value.IsEmpty -> bool
value[index: int32] -> uint8
value[index: System.Index] -> uint8
value[range: System.Range] -> bytestring
value.Subslice(lo: int32, hi: int32) -> bytestring
value.Subslice(range: System.Range) -> bytestring
value.Concat(other: bytestring) -> bytestring
value.Equals(other: bytestring) -> bool
value.CompareTo(other: bytestring) -> int32
value.GetHashCode() -> int32
value.StartsWith(prefix: bytestring) -> bool
value.EndsWith(suffix: bytestring) -> bool
value.IndexOf(needle: bytestring) -> int32
value.CopyTo(destination: slice[uint8]) -> void
value.ToArray() -> array[uint8]
value.ToSlice() -> slice[uint8]
value.Detach() -> bytestring
value.GetEnumerator() -> ByteString.Enumerator
```

ByteString implements `IEquatable<ByteString>`, `IComparable<ByteString>`
and `IEnumerable<byte>`, with ordinary object equality/hash overrides.
Its public value enumerator supports allocation-free pattern-based `for`.
Interface-based enumeration may box; this must be measured and documented.
It has no mutating methods or ref-returning members.

| Operation | Selected semantics |
| --- | --- |
| `Length`, indexing | Number of bytes and one unsigned byte, not UTF-16 units or decoded scalar count. Valid element indices satisfy `0 <= index < Length`. |
| Range / `Subslice` | Exclusive endpoints with `0 <= lo <= hi <= Length`; capacity is not a bound. Resolve `Index`/`Range` from-end operands against this value's logical length. `value[^0]` fails; `value[Length..]` is empty. |
| Evaluation | Save receiver and evaluate written operands once in source order; perform collection bounds checks after argument evaluation. Exceptions during operand evaluation still abort later operands normally. Reuse ADR-0187's `Index`/`Range` construction behavior rather than invent a second range type. |
| Equality / `==`, `!=` | Equal lengths and equal bytes, independent of owners, offsets and allocation history. Override object equality consistently; unrelated object types are unequal. |
| Order / `<`, `<=`, `>`, `>=` | Unsigned lexicographic byte order, with a proper prefix sorting first. `CompareTo` promises sign, not a particular magnitude. |
| Hash | Equal byte values have equal hashes, including default/constructed empty and distinct owners. No stable cross-process or Go hash promise. Hashing does not decode text. |
| `+` / `Concat` | Exact concatenation. An empty operand may reuse the other value; nonempty operands produce owned contiguous result bytes. Check combined length before allocation/copy. |
| Prefix / suffix / search | Bytewise; empty prefix and suffix match. Empty needle returns zero, absent needle returns `-1`, other results are byte offsets. |
| `CopyTo` | Require destination logical length at least `Length`; validate before writing, copy all bytes, leave excess destination bytes unchanged. Unlike slice `CopyTo`, never silently copy a short prefix. |
| `ToArray`, `ToSlice` | Independent writable contents; empty results are non-null/non-nil. Mutating a result cannot change this value or another result. Empty storage may use canonical zero-length storage. |
| `Detach` | An independent compact backing allocation for nonempty values, even if the input is already compact. Empty returns canonical empty. No retained parent owner. |

Use ordinary CLR argument exceptions for invalid indices, ranges and short
copy destinations. A too-large combined length throws `OverflowException`;
allocation failure remains allocation failure. Faults are not encoded as
empty strings, partial copies or arbitrary nil results. Go lowering supplies
source-width bounds checks and source fault translation where needed.

`ToString()` must not silently choose a text encoding. Propose a bounded,
encoding-neutral escaped-byte diagnostic display, never a round-trip protocol
format. Debugger display should include byte length and a bounded escaped
preview, and must not decode, normalize or expose the owner.
Applications explicitly call `DecodeUtf8` for text output.

### 5. Literal and syntax integration

An immediately adjacent lowercase `b` and double quote start a byte literal:

```gsharp
let header = b"\xCA\xFE"
let separator bytestring = b":"
let invalid = b"\xFF\0"
let encoded = b"\u00E9"
let same = b"\xC3\xA9"
```

`encoded == same`; `invalid.Length == 2`. Plain quoted literals retain CLR
`string` type in every context, including a `bytestring` parameter. There is
no target-typed reinterpretation of `"text"` and no implicit encoding.

Literal rules:

- Unescaped Unicode scalar source characters encode to UTF-8, without a BOM
  or normalization. A source decoding error is never silently repaired.
- `\xHH` contributes exactly one byte. `\0`, `\n`, `\r`, `\t`, `\\` and `\"`
  contribute their byte values. Unknown escapes are errors.
- `\uHHHH` and `\UHHHHHHHH` require valid scalar values and contribute UTF-8.
  Surrogates and values above U+10FFFF diagnose rather than become malformed
  UTF-8. Arbitrary byte sequences use `\xHH` instead.
- No literal newline, interpolation or automatic concatenation exists in
  this form. Dollar signs are literal bytes, including `${...}` text.
  Raw/multiline byte literals and explicit interpolation are deferred.
- The lexer recognizes the prefix only at an unescaped identifier boundary
  with no whitespace. `b`, `$b`, `ab`, `B` and ordinary string/interpolation
  tokens keep their meaning outside this exact form.

The compiler retains exact literal bytes through syntax, binding, code model,
formatting and emission. It must not route `\xFF` through CLR text encoding.
Repeated evaluation of one literal site has no recurring byte-buffer
allocation after its initialization. Backing storage is private and immutable;
pooling equal literals is not source-visible identity. Emission/order/names
must be deterministic.

The initial implementation lowers literals through the ordinary imported
static-call machinery to editor-hidden compiler support
`ByteString.FromLiteral(string hexadecimalBytes)`. Hexadecimal is a lossless
compiler interchange, not a text encoding of the byte-string value.
A runtime `ConditionalWeakTable` keyed by the emitted CLR string literal
publishes private immutable storage; the warm lookup creates no callback or
byte buffer. Competing first evaluations may construct candidates, but only
the published descriptor is returned. The table does not strongly retain
dynamically supplied keys. Equal literals may share storage; no identity or
cross-module pooling contract is added. Synthesized literal-holder fields
remain an alternative if measurements justify replacing the cached call.
The code-model factory snapshots bytes as hexadecimal and the printer emits
exact byte escapes without decoding them.

Compiler recognition validates the nominal type and its required signatures.
GS0627 reports missing/incompatible runtime support; GS0628 reports malformed
literal escapes/scalars or lossy on-disk source decoding. Loading a file with
byte literals checks its original BOM-selected encoding strictly once per source document,
including all interpolation-hole parsers;
ordinary files without byte literals retain their existing loader behavior.
File loaders decode and retain one byte buffer, including BOM detection, so parsing
and encoding validation cannot observe different disk reads.
The REPL's existing compiled submission path uses the same bound imported call,
not a separate string-based interpreter representation.

Byte literals are typed value expressions, not CLR metadata constants.
The initial proposal does not admit them as attribute arguments, optional
parameter constants or `const` fields, or add compile-time byte-string
concatenation. Ordinary initialized fields/locals and operator calls work.
Pattern constant support requires a separate explicit decision; use content
comparison in the meantime. This restriction does not permit go2gs to drop
source constant facts; the frontend still owns them.

Recognized byte-string indexing and slicing must agree with the nominal
indexer and method forms. Prefer the existing indexer/range machinery when
it preserves the evaluation contract. Do not add a new application-visible
index wrapper or new loop grammar.

### 6. Encoding and code-point algorithms

Encoding is opt-in. There is no global decoder default and no implicit
byte-string/CLR-string conversion. The implemented public policy enums live
beside ByteString in `Gsharp.Values` and are equally usable by C#.

```text
Utf8Decoding = Strict | ReplaceInvalidByte
Utf16Encoding = Strict | ReplaceUnpairedCodeUnit

ByteString.EncodeUtf8(text: string, policy: Utf16Encoding) -> bytestring
value.DecodeUtf8(policy: Utf8Decoding) -> string
value.DecodeUtf8Scalars(policy: Utf8Decoding) -> ByteString.Utf8Enumerable
Utf8Item = { ByteOffset: int32, Value: int32, ByteLength: int32 }
ByteString.Utf8Enumerable.GetEnumerator() -> ByteString.Utf8Enumerable.Enumerator
ByteString.Utf8Enumerable.Enumerator.MoveNext() -> bool
ByteString.Utf8Enumerable.Enumerator.Current -> Utf8Item
```

No method has a policy default. `EncodeUtf8` rejects a null CLR argument
with `ArgumentNullException` (`text`). All five methods reject invalid policies
with `ArgumentOutOfRangeException` (`policy`), including on empty input.
`DecodeUtf8Scalars` checks the policy at the factory call, without decoding bytes.

The implemented code-point collection APIs also require explicit policies:

```text
CodePointEncoding = Strict | ReplaceInvalidCodePoint
ByteString.FromCodePoints(source: readonly slice[int32],
                         policy: CodePointEncoding) -> bytestring
value.DecodeCodePoints(policy: Utf8Decoding) -> slice[int32]
```

`ByteString.Utf8Enumerable` and its nested `Enumerator` are value types.
They provide concrete pattern-based enumeration without collection interfaces.
`Utf8Item` is a value type in `Gsharp.Values` with get-only properties and an
internal constructor. Each yielded item contains one valid Unicode scalar,
its byte offset relative to this value, and its consumed input byte length.
Default/empty enumerable and enumerator values enumerate empty.
Re-enumeration starts fresh; copied enumerators have independent cursors.
The enumerable retains only immutable ownership, without exporting storage.
Scalar values are represented by `int32`. This does not
redefine G# `char`, or treat every `int32`/Go rune as a valid scalar.
`FromCodePoints` deliberately accepts unrestricted signed `int32` input so
callers can validate or replace invalid values explicitly.

| Policy | Required behavior |
| --- | --- |
| UTF-8 strict | Accept only shortest-form scalar encodings. Reject stray continuation bytes, overlong forms, encoded surrogates, out-of-range values and truncated sequences. Report the cursor where decoding the first malformed sequence started, not a later continuation-byte offset. |
| Replace invalid byte | At each position decode a valid complete scalar if possible; otherwise emit U+FFFD and advance exactly one byte. A valid encoded U+FFFD advances three bytes. |
| UTF-16 strict | Encode scalar pairs and individual non-surrogates. Reject the first unpaired surrogate at its UTF-16 code-unit offset. |
| Replace unpaired code unit | Each unpaired surrogate becomes U+FFFD. A valid pair is one scalar; no normalization occurs. |
| Code-point strict | Reject negative values, surrogate values and values above U+10FFFF at their input element index. |
| Replace invalid code point | Each invalid element becomes U+FFFD; valid values retain their encoding. |

Strict conversions and scalar iteration throw `ByteStringEncodingException`, a sealed
`System.Exception` subclass in `Gsharp.Values`. Its get-only `InputKind`
property has public enum type `ByteStringInputKind`: `Utf8 = 0`, `Utf16 = 1`
and appended `CodePoints = 2`. Its get-only `Offset: int32` is the zero-based
first failing byte, UTF-16 code unit or input element index, respectively.
Construction is internal: callers catch the exception and inspect these
properties. `DecodeCodePoints` reports malformed UTF-8 as `Utf8`, not
`CodePoints` or an output element index. Offsets are relative to the input value,
including substrings, not its backing owner. Eager operations return no partial
value. Invalid policy enum values throw `ArgumentOutOfRangeException`.
These are ordinary exceptions under ADR-0005, not a Go error-return protocol.

Lazy strict enumeration can yield a valid prefix before failing at `MoveNext`.
It must never replace a strict failure with end-of-sequence or continue after
failure. State this distinction in API docs; callers needing all-or-nothing
validation use an eager operation before consuming results.
The strict fault cursor remains unadvanced. Every subsequent `MoveNext` reports
the same failure offset, rather than advancing or returning false.
Decoding never reads past a substring's logical end, even when its owner
contains bytes that would complete the scalar.
UTF-8 enumeration offsets are relative to this byte-string value, not its
backing owner's offset. UTF-8 BOM bytes decode to U+FEFF; encoding does not
insert a BOM and decoding does not strip one.

`DecodeCodePoints` returns independent mutable `slice[int32]` data.
Separate calls do not share mutable result storage. Empty decoding returns
a present empty slice, not default/nil. It consumes the existing scalar
enumerator, without a second UTF-8 decoder. `FromCodePoints` snapshots its
input's logical view. Callers keep the input stable during encoding, as for
`CopyFrom`; concurrent mutation has no atomic-snapshot guarantee.
Empty/default readonly views encode to ordinary empty byte strings.
BCL Rune/encoding routines may be implementation building blocks,
but only if they satisfy the selected policy, error offset and progress
rules. Different replacement grouping is not a permitted optimization.

### 7. Costs, retention and CLR interoperability

The initial owner is a managed contiguous byte array. Lengths and offsets
are `int32`; maximum allocation size remains runtime/platform dependent.
Do not promise that every positive `int32` length can be allocated.
Ropes, segmented strings, pooling, disposal, pinning and native ownership
are not included in this proposal.

| Path | Proposed cost contract, excluding first-use runtime initialization |
| --- | --- |
| Default, length, indexing, descriptor assignment | Constant-time, zero allocation. |
| Nonempty substring | Constant-time descriptor construction, no byte copy or allocation. It retains the complete original owner. |
| Empty substring | Canonical empty, no retained owner. |
| Content equality/order/hash | Linear worst case in compared/hashed bytes; no per-call allocation. Owner equality may be a safe fast path, never the definition. |
| Prefix/suffix/search | No per-call allocation; search algorithm/complexity must be documented and benchmarked before implementation acceptance. No quadratic-time claim is hidden behind an API name. |
| Concatenation of two nonempty values | Linear copy into one result byte buffer; repeated `result = result + part` can be quadratic in total output size. |
| Copy factory, detach, mutable export | Linear copy into one output buffer. No extra wrapper object is required for a value descriptor. |
| Direct byte and UTF-8 enumeration | Value enumerators, no per-byte/per-scalar boxing, buffer copy or allocation. Byte enumeration through collection interfaces can box once; UTF-8 enumeration exposes only the concrete pattern. |
| Eager encoding/decoding | Linear processing plus result storage; exact allocation budgets require implementation evidence. |

Eager `DecodeUtf8` consumes the same scalar enumerator. It uses one reusable
UTF-16 buffer, not a temporary string per scalar. The scalar allocation test
warms both policies, then measures 64 passes over an 8192-byte bounded view:
zero allocated bytes on the concrete path. This is a measured regression
budget, not a throughput claim or full witness-matrix certification.

`FromCodePoints` uses a growing byte buffer and copies its written bytes into
private immutable storage. `DecodeCodePoints` collects the existing scalar
enumerator's values and returns an independent array-backed native slice.
Both paths are linear with standard-library checked buffer growth plus result
storage; neither promises zero allocation or an exact allocation budget.

Substring retention is explicit, not an automatic heuristic based on owner
size. Users can call `Detach` before caching a small long-lived token.
No hidden copy threshold may make slicing unpredictably expensive.
Efficient many-part building is a follow-up bulk-construction API if needed,
not an excuse to replace the initial value with a mutable builder.

C# consumers use `ByteString`, ordinary indexers/operators and methods.
Nominal `IEquatable`/hash behavior must work through object boxing and generic
collections. C# and G# must agree about nullability, default/empty, content
comparison and exported mutable copies. No reflection-based dispatch is needed.

CLR text conversion remains explicit at APIs that require `string`.
Binary I/O initially uses a caller-owned destination and `CopyTo`, or a copied
array/slice. Shared-memory or async I/O convenience APIs require a separate
review of ownership and backing recovery, not an accidental `AsMemory`.
The type's private storage format is not a serialization or native-marshalling
contract. P/Invoke and JSON support are not inferred from the name.

### 8. Independent and discriminating evidence

This matrix spans the core and later encoding work. Implementation PRs record
only the witnesses actually executed; deferred rows remain obligations, not
certification claims. The original design PR ran no product tests, allocation
benchmarks or behavioral mutants. Examples using deferred APIs remain source
review material, not compiled samples.

Use hand-authored exact byte vectors, scalar/offset vectors, encoding rules
and C#/G# cross-language fixtures. The implementation must not generate its
expected answers through its own decoder or printer. For go2gs adoption add
unchanged original Go witnesses under the selected toolchain, not as the
only oracle for the general-purpose type.

| Area | Required witness | Wrong implementation that must fail (ADR-0154) |
| --- | --- | --- |
| Immutable publication | Copy from mutable arrays, native slices and readonly aliases; mutate each source after construction, observe original byte-string bytes. | Adopt an input owner through a readonly view. |
| Writable exports | Mutate two separately exported buffers and observe the byte string, exports and sibling substrings. | Return owner or share mutable exports. |
| Default/null | Compare default, literal empty, copied empty, nullable absent and present empty; test dictionary keys through G# and C#. | Treat owner null as an absent byte string or use descriptor equality. |
| Equality/order/hash | Same bytes at different offsets/owners; `00`, `7F`, `80`, `FF`, embedded zero, proper prefixes and malformed UTF-8. | Compare owner identity, signed bytes, text decoding or culture. |
| Index/range | Boundary and from-end forms, `^0`, empty/full ranges, invalid endpoints; effectful receiver and both bounds. | Index capacity; clamp; check before a later bound executes; reevaluate the receiver. |
| Slice cost/retention | Retain a small view after dropping its parent, collect; empty view releases owner; detached view does not retain parent storage. | Copy every slice, retain owner for empty, or implement detach as descriptor copy. |
| Literal bytes | `b"\xFF\0"` and Unicode/hex equivalence; `$` stays data; malformed scalar/hex escapes diagnose with spans. | Encode a CLR intermediate that changes `FF`, interpolate dollar text or accept surrogate escapes. |
| Existing source | User type/alias/escaped identifier named bytestring; identifiers `b`/`B`; ordinary strings/interpolation; original CLR overload choices. | Reserve ordinary names or retarget string literals. |
| UTF-8 policy | `FF`, `C0 AF`, `E2 82`, `ED A0 80`, `F4 90 80 80`, valid `EF BF BD` and a supplementary scalar; exact values, offsets and byte widths. | Group invalid bytes, use UTF-16 units as offsets or loop without progress. |
| UTF-16/code points | Paired/unpaired surrogates, negative points, U+D800, U+10FFFF, U+110000; strict error offset and replacement counts. | Silently normalize, accept invalid scalar or return a partial eager value. |
| Lazy failure | Consume a valid prefix then an invalid byte in strict mode; distinguish EOF and a thrown failure. | Truncate iteration or silently switch to replacement. |
| Copy/concat/errors | Short destination unchanged; destination tail unchanged; overflow before result allocation; empty operands; invalid policy values. | Copy only a short prefix or wrap the combined length. |
| Enumeration/cost | Distinct byte and scalar values, direct and interface enumeration, substring/concat paths, literal reuse, detached copy allocations. | Box per element, clone on enumeration or allocate each time a literal is evaluated. |
| Toolchain/ABI | Reflection and C# consumers; nullable generic containers, reference assembly, missing/mismatched runtime, deterministic emit, interpreter boundary. | Erase to object/string, accept a lookalike runtime or emit a default value on an unsupported path. |

Allocation/retention tests need allocation counters, lifetime probes and
shape-equivalent controls, not elapsed-time-only assertions. Keep owners alive
explicitly during retained-view probes and avoid JIT-lifetime-dependent weak
reference assertions. Run exact semantic byte/scalar vectors in emitted JIT
and NativeAOT programs and ILVerify emitted managed code. Reuse existing
repository harnesses and source-backed test conventions.

The interpreter must implement the same byte semantics or issue an explicit
compiled-only diagnostic before running the affected code. A silent CLR
string substitution is not an interpreter fallback.

### 9. Delivery and acceptance gates

1. Review and accept this ADR's source, semantic and cost contracts. Check
   the handwritten examples with binary/text users, not only translator needs.
   Proposed status alone does not accept the nominal ABI or literal grammar.
2. Implement the ordinary runtime value and integrated compiler surface in
   focused changes. Include identity checks, binding/emit, declaration-view
   safety, literal preservation, formatter, code model/printer, LSP display/
   completion and interpreter behavior. Do not ship an undocumented API-only
   stopgap as the completed capability.
3. Prove the witness matrix with independent oracles and ADR-0154 mutants,
   C# interoperability, ILVerify, JIT/AOT semantics and allocation evidence.
   Set measured performance budgets before claiming performance readiness.
4. Release the capability, then move the repository SDK pin in a separate
   N-1 PR. Compiler/runtime implementation must itself build with the current
   published pin; future syntax belongs in fixture strings until available.
5. Admit ADR-0191's selected text profile against the released capability.
   Keep Go-specific Unicode tables, nil slice conversions and panic translation
   explicit. A successful byte-string feature is not a completed Go package.

Interface values, receiver-copy semantics and value arrays remain independent
design tracks. None must be rushed into this type, and bytestring does not
change the existing `[]T` source epoch or ordinary `string` ABI.

## Consequences

Handwritten and translated G# gain one encoding-neutral immutable value rather
than a source-language-specific wrapper. Binary operations stay byte operations;
text interpretation is visible. Integrated syntax makes signatures, delimiters
and range operations readable without changing CLR text behavior.

The cost is a runtime type, a compiler-recognized alias/literal surface and
consistent tooling support. Substrings can retain large owners; explicit
detach trades a copy for predictable retention. Mutable boundaries copy.
No zero-copy mutable-array import, implicit text conversion or universal
string-constant support is promised.

Later byte-string APIs must preserve these immutability and content contracts.
The core addition does not change CLR `string`, reserve a keyword, or authorize
repository adoption before a release and the separate N-1 pin update.

## Alternatives considered

| Alternative | Decision / tradeoff |
| --- | --- |
| CLR `string` | Keep for CLR text. UTF-16 indexing and inability to preserve arbitrary original bytes make it the wrong storage for this capability. |
| Strict UTF-8 string | Useful separate invariant, but not an arbitrary byte string. Do not mix validation into ordinary slicing or silently repair invalid bytes. |
| `readonly slice[uint8]` | Reuse internally where useful, not as the public type. Writable aliases and descriptor equality do not establish this contract. |
| `slice[int32]` | Use as decoded mutable algorithm data. It cannot retain arbitrary invalid byte sequences or byte offsets without extra evidence. |
| Library only, explicit `ByteString` | Feasible comparison baseline. Does not require new scalar/text semantics, but factory-heavy literals and repeated nominal spelling make binary source less direct. Not selected as the final ergonomics contract. |
| Contextual conversion of `"text"` | Reject: implicit encoding and overload/type-context dependence obscure the byte/text boundary and risk existing source behavior. |
| New hard keyword or type erasure | Reject: preserve ordinary-name precedence, CLR nominal identity and interop. |
| Public GoString / source-specific runtime API | Reject: no reusable handwritten-language benefit, and translated code exposes implementation rather than ordinary operations. |
| Rope or segmented storage | Defer. It changes indexing, sharing and interop costs; require workloads that justify it rather than expanding the initial ABI. |
| Public span/memory backing views | Defer pending an ownership review. The initial design chooses immutable guarantees and copied I/O boundaries over recoverable writable owners. |

## References

- [Go string types][go-strings] and [string conversions][go-conversions].
- [.NET Rune decoding][rune-decode] exposes status and byte consumption.
- [.NET UTF8Encoding][utf8-encoding] makes error policy a caller decision.
- [.NET ReadOnlyMemory][readonly-memory] is a memory view, not ownership transfer.

[go-strings]: https://go.dev/ref/spec#String_types
[go-conversions]: https://go.dev/ref/spec#Conversions_to_and_from_a_string_type
[rune-decode]: https://learn.microsoft.com/en-us/dotnet/api/system.text.rune.decodefromutf8
[utf8-encoding]: https://learn.microsoft.com/en-us/dotnet/api/system.text.utf8encoding.-ctor
[readonly-memory]: https://learn.microsoft.com/en-us/dotnet/api/system.readonlymemory-1

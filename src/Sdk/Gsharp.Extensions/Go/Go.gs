// ADR-0084 §L5 / issue #806. G#-authored port of the
// `Gsharp.Extensions.Go.GoExtensions` marker that previously lived
// under `src/Sdk/Gsharp.Extensions/Go/GoExtensions.cs`. The issue
// permits leaving the Go subspace as-is, but porting it is the
// cleanest way to consolidate the entire Gsharp.Extensions assembly
// onto a single `.gsproj`-style build (no hybrid C# + G# build
// orchestration needed).
//
// ADR-0082 / issue #722. The Go-flavored concurrency surface (the
// `go` statement, `chan T` type, `<-` send / receive operators,
// `select` statement, `close(ch)` built-in, and `make(chan T)`
// constructor) is compiler-built-in: the binder gates each form on a
// per-file `import Gsharp.Extensions.Go`. The library side
// contributes channel-related helpers in follow-up issues (#723
// Go-style built-ins, #724 helper namespaces); the marker class here
// lets the namespace round-trip through `System.Type`-based reference
// resolution and ensures the assembly carries at least one public
// type so it is published and referenced normally.

package Gsharp.Extensions.Go

class GoExtensions {
}

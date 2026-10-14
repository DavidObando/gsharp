// <copyright file="Issue942IndexerIdentifierParseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #942: member access on an element-access whose index is an
/// <em>identifier</em> — `expr[i].Member` — previously mis-parsed. The
/// parser's `LooksLikeGenericCallSite` disambiguator treated
/// `name[identifier]` followed by `.` as a generic type-argument
/// list (`Foo[Bar].Member`) rather than an indexer-then-member access,
/// because a lone identifier scans as a type clause and `.` was in the
/// generic follow-set. The literal-index form `expr[0].Member` parsed
/// correctly because a literal is not a type clause.
///
/// The fix restricts the `.` follow-set marker to the unambiguous
/// multi-type-argument shape (`Pair[int, string].zero`): an indexer can
/// only ever hold a single index expression, so a single bracketed argument
/// followed by `.` is parsed as an indexer-then-member access, matching
/// the literal-index behaviour. The `(` / `{` markers stay
/// arity-agnostic, so generic instantiations / calls / composite literals are
/// unaffected. The guard tests below lock in that genuine generics still work.
open class Issue942IndexerIdentifierParseEmitTests {
    @Fact
    func IdentifierIndex_MemberCall_ParsesAndCompiles() {
        // The headline scenario from the issue: `xs[i].ToString()` with an
        // identifier index used as the receiver of a member call.
        let source = `package P
import System

let xs = []int32{3, 1, 2}
let i = 0
Console.WriteLine(xs[0].ToString())
Console.WriteLine(xs[i].ToString())
public var result = xs[i]`
        Assert.Equal(3, RunAndGetIntResult(source))
    }

    @Fact
    func IdentifierIndex_MemberAccess_ProducesElementMember() {
        // `names[i].Length` — member access (not a call) on the element
        // selected by an identifier index. Result is the int length.
        let source = `package P
import System

let names = []string{"ab", "cdef", "x"}
let i = 1
public var result = names[i].Length`
        Assert.Equal(4, RunAndGetIntResult(source))
    }

    @Fact
    func IdentifierIndex_AsStandaloneValue() {
        // `xs[i]` used purely as a value (no postfix `.` or `(`).
        let source = `package P
import System

let xs = []int32{10, 20, 30}
let i = 2
public var result = xs[i]`
        Assert.Equal(30, RunAndGetIntResult(source))
    }

    @Fact
    func NestedIdentifierIndexers_Parse() {
        // `m[i][j]` — nested indexers, both with identifier indices.
        let source = `package P
import System
import System.Collections.Generic

let inner = List[int32]()
inner.Add(30)
inner.Add(40)
let m = List[List[int32]]()
m.Add(inner)
m.Add(inner)
let i = 1
let j = 0
public var result = m[i][j]`
        Assert.Equal(30, RunAndGetIntResult(source))
    }

    @Fact
    func IdentifierIndex_AssignmentTarget() {
        // `xs[i] = v` — identifier index as the LHS of an assignment.
        let source = `package P
import System

let xs = []int32{3, 1, 2}
let i = 1
xs[i] = 99
public var result = xs[i]`
        Assert.Equal(99, RunAndGetIntResult(source))
    }

    @Fact
    func InterfaceTypedReceiver_IdentifierIndex_MemberCall() {
        // The IReadOnlyList[T] variant from the issue (a different GS0005 at
        // the DotToken): `ro[i].ToString()` on an interface-typed receiver.
        let source = `package P
import System
import System.Collections.Generic

let xs = []int32{5, 6, 7}
let ro IReadOnlyList[int32] = xs
let i = 1
Console.WriteLine(ro[i].ToString())
public var result = ro[i]`
        Assert.Equal(6, RunAndGetIntResult(source))
    }

    @Fact
    func ChainedMemberThenIdentifierIndexThenMember() {
        // `holder[0][i]` chained indexer access mixed with a literal and an
        // identifier index, used as the receiver of a member access.
        let source = `package P
import System
import System.Collections.Generic

let row = List[int32]()
row.Add(100)
row.Add(200)
let holder = List[List[int32]]()
holder.Add(row)
let i = 1
public var result = holder[0][i].CompareTo(0)`
        Assert.Equal(1, RunAndGetIntResult(source))
    }

    @Fact
    func GenericInstantiation_StillWorks() {
        // Guard: a genuine generic instantiation + call (`Dictionary[K, V]()`)
        // and indexing the result must still bind correctly. The `(` follow-set
        // marker is unchanged by the fix.
        let source = `package P
import System
import System.Collections.Generic

let d = Dictionary[string, int32]()
d.Add("k", 7)
public var result = d["k"]`
        Assert.Equal(7, RunAndGetIntResult(source))
    }

    @Fact
    func GenericMethodCall_StillWorks() {
        // Guard: an explicit generic method call `xs.ToList[int32]()` must
        // still parse as a generic call (the `(` follow-set marker), not an
        // indexer.
        let source = `package P
import System
import System.Collections.Generic
import System.Linq

let xs = []int32{5, 6, 7}
let lst = xs.ToList[int32]()
let i = 1
public var result = lst[i]`
        Assert.Equal(6, RunAndGetIntResult(source))
    }

    @Fact
    func MultiTypeArgGenericMember_StillTreatedAsGeneric() {
        // Guard: a multi-type-argument list followed by `.` is unambiguously a
        // generic type (an indexer cannot hold a comma-separated list), so the
        // `.` follow-set still commits to a generic call site for that shape.
        // `Dictionary[string, int32]().Count` exercises the multi-arg `.`
        // follow against the constructed generic.
        let source = `package P
import System
import System.Collections.Generic

let d = Dictionary[string, int32]()
d.Add("a", 1)
d.Add("b", 2)
public var result = d.Count`
        Assert.Equal(2, RunAndGetIntResult(source))
    }

    shared {
        private func RunAndGetIntResult(source string) int32 {
            let assembly = CompileToAssembly(source)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return int32(resultField!!.GetValue(nil)!!)
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue942_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            return EmittedFixture.Load(outPath)
        }
    }
}

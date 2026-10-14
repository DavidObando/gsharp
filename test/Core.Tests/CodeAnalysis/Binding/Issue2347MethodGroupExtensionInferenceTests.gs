// <copyright file="Issue2347MethodGroupExtensionInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #2347: a bare imported/BCL method group (e.g. `Char.IsAsciiHexDigit`)
/// passed as an argument to an imported <em>generic</em> extension method (e.g.
/// `Enumerable.All<TSource>`) failed with GS0159 "Cannot find function
/// All", while the equivalent lambda (`(c) -> Char.IsAsciiHexDigit(c)`)
/// bound fine. The root cause was general, not LINQ-specific: an unresolved
/// method-group argument ((cref:GSharp.Core.CodeAnalysis.Binding.BoundClrMethodGroupExpression)
/// / (cref:GSharp.Core.CodeAnalysis.Binding.BoundMethodGroupExpression)
/// with no fixed `MethodInfo`/`FunctionType` yet) carries the
/// `TypeSymbol.Error` sentinel as its natural type, and every CLR
/// call-binding path that builds the argument-type vector for
/// `ClrOverloadResolution.Resolve`/`TryInferTypeArguments` (imported
/// extension calls, static/instance CLR calls, constructors, constrained
/// interface/object-member calls) treated that as a hard "argument not typed"
/// failure — aborting the whole candidate instead of deferring the method
/// group the same way an untyped arrow lambda is deferred. The fix recognises
/// this shape everywhere (`ClrOverloadResolution.IsUnresolvedMethodGroupArgument`),
/// lets generic inference/applicability proceed using the other arguments (the
/// receiver, in the LINQ case), and resolves the method group against the
/// winning candidate's parameter type afterwards via the existing
/// `ConversionClassifier.BindConversion` → `BindClrMethodGroupConversion`
/// / `BindUserMethodGroupConversion` machinery — the same mechanism a
/// `var f Func[...] = SomeType.SomeMethod` assignment already used.
open class Issue2347MethodGroupExtensionInferenceTests {
    @Fact
    func BareBclMethodGroup_ToImportedGenericExtensionPredicate_ExactOahuShape_Compiles() {
        // Exact Oahu.Diagnostics ExportCheck shape: a `string` receiver's
        // `All` (Enumerable.All<char>, an imported GENERIC extension method)
        // predicate is a bare BCL static method group, not a lambda.
        // Char.IsAsciiHexDigit itself has two overloads (char, Rune); only the
        // (char) overload matches the Func[char,bool] the resolved TSource=char
        // candidate requires, exercising the overload-set/element-type-
        // inference generalization the issue asked for, not just a single-
        // overload happy path.
        let source = `
package Repro
import System
import System.Linq

func Main() {
    let key = "0123456789ABCDEF0123456789ABCDEF"
    if key.Length != 32 || !key.All(Char.IsAsciiHexDigit) {
        Console.WriteLine("bad key")
    }
}
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func EquivalentLambda_ToImportedGenericExtensionPredicate_StillCompiles() {
        // Control: the pre-existing working form (an explicit lambda wrapping
        // the same BCL method) must keep compiling unchanged.
        let source = `
package Repro
import System
import System.Linq

func Main() {
    let key = "0123456789ABCDEF0123456789ABCDEF"
    if key.Length != 32 || !key.All(func(c char) bool { return Char.IsAsciiHexDigit(c) }) {
        Console.WriteLine("bad key")
    }
}
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func BareBclMethodGroup_ToImportedGenericExtension_OnCharListReceiver_Compiles() {
        // Generalization beyond `string`: the same bare method group against
        // Enumerable.All<TSource> with TSource inferred from a List[char]
        // receiver (a different imported generic-collection receiver shape
        // than the string/ReadOnlySpan-backed IEnumerable<char> above).
        let source = `
package Repro
import System
import System.Collections.Generic
import System.Linq

func Main() {
    var chars = List[char]()
    chars.Add('A')
    chars.Add('1')
    var allHex = chars.All(Char.IsAsciiHexDigit)
    Console.WriteLine(allHex)
}
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func BareBclMethodGroup_ToImportedGenericInstanceMethod_NonExtension_Compiles() {
        // Generalization beyond LINQ/extension methods: List[T].Find(Predicate[T])
        // is a genuine (non-extension) GENERIC instance method on an imported
        // class. This exercises the same argument-type-vector construction
        // fix through a different call-binding path (instance CLR calls)
        // than the extension-method path used by All/Where/Select above.
        let source = `
package Repro
import System
import System.Collections.Generic

func Main() {
    var chars = List[char]()
    chars.Add('x')
    chars.Add('9')
    var firstHex = chars.Find(Char.IsAsciiHexDigit)
    Console.WriteLine(firstHex)
}
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func BareMethodGroup_WithNoOverloadMatchingInferredDelegate_ReportsDiagnostic() {
        // Negative/ambiguity control: Console.WriteLine has many overloads but
        // none returns bool, so none can satisfy the Func[char,bool] that
        // Enumerable.All<char> requires. The fix must not silently accept an
        // incompatible method group merely because it is now deferred like a
        // lambda — BindClrMethodGroupConversion still rejects it and the
        // existing diagnostic must surface, exactly as it would for an
        // equivalent lambda whose body does not type-check.
        let source = `
package Repro
import System
import System.Linq

func Main() {
    let key = "0123456789ABCDEF0123456789ABCDEF"
    if key.All(Console.WriteLine) {
        Console.WriteLine("unreachable")
    }
}
`
        let diagnostics = EmitDiagnostics(source, out var success)
        Assert.False(success, "Expected the incompatible method group to fail to compile.")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError)
    }

    @Fact
    func UserDefinedGenericFunction_WithUserDefinedStaticMethodGroupArgument_StillCompiles() {
        // Control: a same-compilation (source G#) generic function receiving a
        // same-compilation static method group already worked before this fix
        // (OverloadResolver.cs's user-function overload resolution already
        // special-cased unresolved method groups). This guards that the new
        // imported/CLR-side deferral does not regress or duplicate-handle the
        // existing source-side path.
        let source = `
package Repro
import System
import System.Collections.Generic

func IsHexChar(c char) bool {
    return Char.IsAsciiHexDigit(c)
}

func AllOf[T](xs List[T], predicate (T) -> bool) bool {
    for x in xs {
        if !predicate(x) {
            return false
        }
    }
    return true
}

func Main() {
    var chars = List[char]()
    chars.Add('F')
    chars.Add('2')
    var allHex = AllOf(chars, IsHexChar)
    Console.WriteLine(allHex)
}
`
        AssertCompilesWithoutErrors(source)
    }

    shared {
        private func AssertCompilesWithoutErrors(source string) {
            let diagnostics = EmitDiagnostics(source, out var success)
            Assert.True(
                success,
                "Emit failed:\n" + string.Join("\n", diagnostics.Select((d Diagnostic) -> d.ToString()))
            )
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        }

        private func EmitDiagnostics(source string, out success bool) IReadOnlyList[Diagnostic] {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            success = result.Success
            return result.Diagnostics
        }
    }
}

// <copyright file="Issue1311ImportedMethodNarrowingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1311 — calling an imported/BCL method whose parameter is a narrower
/// integer type (e.g. <c>System.IO.Stream.WriteByte(byte)</c>) with a bare
/// in-range <c>int</c> literal must apply the same implicit constant-narrowing /
/// integer-literal adaptation (C# §10.2.11, issues #1281/#1306/#1307) already
/// applied to user-defined methods and base-constructor initializers. Imported
/// overload resolution previously tested only the lattice conversion and
/// rejected the literal with GS0159 ("Cannot find function").
/// </summary>
public class Issue1311ImportedMethodNarrowingTests
{
    [Fact]
    public void ImportedInstanceMethodLiteralAdaptsToNarrowerParam_BindsWithoutDiagnostics()
    {
        var source = @"
package p
import System.IO
class C {
    func W(file Stream) {
        file.WriteByte(0)
    }
}
";
        Assert.Empty(EmitDiagnostics(source));
    }

    [Fact]
    public void ImportedInstanceMethodLiteralAdaptsOnDerivedReceiver_BindsWithoutDiagnostics()
    {
        var source = @"
package p
import System.IO
class C {
    func W() {
        let ms MemoryStream = MemoryStream()
        ms.WriteByte(0)
    }
}
";
        Assert.Empty(EmitDiagnostics(source));
    }

    [Fact]
    public void ImportedInstanceMethodWithExplicitCast_StillBindsWithoutDiagnostics()
    {
        var source = @"
package p
import System.IO
class C {
    func W(file Stream) {
        file.WriteByte(uint8(0))
    }
}
";
        Assert.Empty(EmitDiagnostics(source));
    }

    [Fact]
    public void ImportedInstanceMethodInRangeLiteralAdapts_BindsWithoutDiagnostics()
    {
        var source = @"
package p
import System.IO
class C {
    func W(file Stream) {
        file.WriteByte(255)
    }
}
";
        Assert.Empty(EmitDiagnostics(source));
    }

    [Fact]
    public void ImportedInstanceMethodOutOfRangeLiteral_StillReportsDiagnostic()
    {
        var source = @"
package p
import System.IO
class C {
    func W(file Stream) {
        file.WriteByte(300)
    }
}
";
        Assert.NotEmpty(EmitDiagnostics(source));
    }

    [Fact]
    public void UserMethodLiteralAdaptation_RemainsUnaffected()
    {
        var source = @"
package p
class C {
    func U(b uint8) {}
    func W() {
        U(0)
    }
}
";
        Assert.Empty(EmitDiagnostics(source));
    }

    [Fact]
    public void ImportedConstructorWithNarrowAndWideOverloads_BindsToNarrowestWithoutAmbiguity()
    {
        // System.UIntPtr exposes both .ctor(UInt32) and .ctor(UInt64). A bare
        // in-range int literal adapts to BOTH via constant-narrowing; the
        // better-conversion-target tie-break must pick the narrower UInt32
        // overload rather than reporting GS0160 ambiguity.
        var source = @"
package p
class C {
    func F() {
        let p = UIntPtr(16)
    }
}
";
        var diagnostics = EmitDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Message.Contains("ambiguous"));
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ImportedStaticMethodLiteralAdaptsToNarrowerParam_BindsWithoutDiagnostics()
    {
        // System.Buffer.SetByte(Array, int, byte) is a single-overload STATIC
        // imported method whose last parameter is `byte`. A bare in-range int
        // literal (255) must adapt via constant-narrowing on the static-call
        // path (ImportedClassSymbol.TryLookupFunction), which previously omitted
        // the check and rejected the literal with GS0159.
        var source = @"
package p
import System
class C {
    func W(a []uint8) {
        Buffer.SetByte(a, 0, 255)
    }
}
";
        Assert.Empty(EmitDiagnostics(source));
    }

    [Fact]
    public void ImportedStaticMethodOutOfRangeLiteral_StillReportsDiagnostic()
    {
        // 999 does not fit `byte`, so the constant-narrowing adaptation fails and
        // the static call remains unresolved — the rule must not silently accept
        // out-of-range constants.
        var source = @"
package p
import System
class C {
    func W(a []uint8) {
        Buffer.SetByte(a, 0, 999)
    }
}
";
        Assert.NotEmpty(EmitDiagnostics(source));
    }

    private static IReadOnlyList<Diagnostic> EmitDiagnostics(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics.ToList();
    }
}

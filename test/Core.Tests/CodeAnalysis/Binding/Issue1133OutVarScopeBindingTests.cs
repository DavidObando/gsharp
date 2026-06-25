// <copyright file="Issue1133OutVarScopeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1133: an inline <c>out var n</c> / <c>out let n</c> / <c>out _</c>
/// declaration on a call to a user-defined <em>instance</em> method (resolved
/// through <see cref="GSharp.Core.CodeAnalysis.Binding.OverloadResolver"/>'s
/// instance-call path) or a <em>qualified static</em> method (e.g.
/// <c>C.G(out var n)</c>, resolved through
/// <c>ExpressionBinder.BindUserTypeStaticCall</c>) must leak the new local into
/// the ENCLOSING block scope, like C#, so later statements can use it.
/// Previously the call site was accepted but using the variable afterwards
/// reported GS0125 ("Variable doesn't exist") because the
/// post-overload-resolution re-bind never declared the local. <c>out _</c>
/// introduces no visible name.
/// </summary>
public class Issue1133OutVarScopeBindingTests
{
    [Fact]
    public void InstanceMethod_OutVar_VisibleInEnclosingScope_NoGS0125()
    {
        const string source = @"
package p
class C {
  func G(out x int32) { x = 5 }
  func F() int32 {
    G(out var y)
    return y
  }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InstanceMethod_OutLet_ReadAfterCall_NoGS0125()
    {
        const string source = @"
package p
class C {
  func G(out x int32) { x = 5 }
  func F() int32 {
    G(out let y)
    return y
  }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InstanceMethod_OutLet_RebindReportsCannotAssign()
    {
        const string source = @"
package p
class C {
  func G(out x int32) { x = 5 }
  func F() int32 {
    G(out let y)
    y = 7
    return y
  }
}
";
        Assert.Contains(GetDiagnostics(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void InstanceMethod_OutVar_ReassignedThenUsed_NoErrors()
    {
        const string source = @"
package p
class C {
  func G(out x int32) { x = 5 }
  func F() int32 {
    G(out var y)
    y = 7
    return y
  }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void InstanceMethod_OutVar_UsedAsLaterCallArgument_NoErrors()
    {
        const string source = @"
package p
class C {
  func G(out x int32) { x = 5 }
  func H(v int32) int32 { return v }
  func F() int32 {
    G(out var y)
    return H(y)
  }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void InstanceMethod_OutDiscard_IntroducesNoVisibleName()
    {
        const string source = @"
package p
class C {
  func G(out x int32) { x = 5 }
  func F() int32 {
    G(out _)
    return 0
  }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ExplicitReceiverInstanceMethod_OutVar_VisibleInEnclosingScope()
    {
        const string source = @"
package p
class C {
  public func G(out x int32) { x = 9 }
}
class D {
  func F() int32 {
    let c = C{ }
    c.G(out var y)
    return y
  }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedStaticMethod_OutVar_VisibleInEnclosingScope_NoGS0125()
    {
        const string source = @"
package p
class C {
  shared {
    func G(out x int32) { x = 5 }
    func F() int32 {
      C.G(out var y)
      return y
    }
  }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedStaticMethod_OutLet_ReadAfterCall_NoGS0125()
    {
        const string source = @"
package p
class C {
  shared {
    func G(out x int32) { x = 5 }
    func F() int32 {
      C.G(out let y)
      return y
    }
  }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedStaticMethod_OutLet_RebindReportsCannotAssign()
    {
        const string source = @"
package p
class C {
  shared {
    func G(out x int32) { x = 5 }
    func F() int32 {
      C.G(out let y)
      y = 7
      return y
    }
  }
}
";
        Assert.Contains(GetDiagnostics(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void QualifiedStaticMethod_OutVar_ReassignedThenUsed_NoErrors()
    {
        const string source = @"
package p
class C {
  shared {
    func G(out x int32) { x = 5 }
    func F() int32 {
      C.G(out var y)
      y = 7
      return y
    }
  }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void QualifiedStaticMethod_OutDiscard_IntroducesNoVisibleName()
    {
        const string source = @"
package p
class C {
  shared {
    func G(out x int32) { x = 5 }
    func F() int32 {
      C.G(out _)
      return 0
    }
  }
}
";
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void QualifiedStaticMethod_OnOtherClass_OutVar_VisibleInEnclosingScope()
    {
        const string source = @"
package p
class Other {
  shared {
    func G(out x int32) { x = 5 }
  }
}
class C {
  shared {
    func F() int32 {
      Other.G(out var y)
      return y
    }
  }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    private static List<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics.ToList();
    }
}

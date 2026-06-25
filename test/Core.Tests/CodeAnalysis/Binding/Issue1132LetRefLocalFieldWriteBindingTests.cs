// <copyright file="Issue1132LetRefLocalFieldWriteBindingTests.cs" company="GSharp">
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
/// Issue #1132: <c>let</c> makes the BINDING read-only, not the heap object the
/// binding points at. A field/property write through a read-only <c>let</c>
/// local must be allowed when the receiver is a reference type (the object is
/// mutated, not the binding) and rejected when the receiver is a value type
/// (the value held in the read-only slot would be mutated). Rebinding the local
/// (<c>b = other</c>) stays rejected for both. These tests pin the GS0127
/// behaviour across simple, compound, and increment member writes.
/// </summary>
public class Issue1132LetRefLocalFieldWriteBindingTests
{
    [Fact]
    public void LetClassLocal_FieldWrite_Allowed()
    {
        const string source = @"
package p
class Box { var Value int32 = 0 }
class C {
  func F() int32 {
    let b = Box{ }
    b.Value = 5
    return b.Value
  }
}
";
        Assert.DoesNotContain(GetDiagnostics(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetStructLocal_FieldWrite_Rejected()
    {
        const string source = @"
package p
struct S { var Value int32 }
class C {
  func F() int32 {
    let s = S{ Value: 1 }
    s.Value = 5
    return s.Value
  }
}
";
        Assert.Contains(GetDiagnostics(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetClassLocal_Rebind_Rejected()
    {
        const string source = @"
package p
class Box { var Value int32 = 0 }
class C {
  func F() int32 {
    let b = Box{ }
    b = Box{ }
    return b.Value
  }
}
";
        Assert.Contains(GetDiagnostics(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetClassLocal_CompoundFieldWrite_Allowed()
    {
        const string source = @"
package p
class Box { var Value int32 = 0 }
class C {
  func F() int32 {
    let b = Box{ }
    b.Value += 1
    return b.Value
  }
}
";
        Assert.DoesNotContain(GetDiagnostics(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetStructLocal_CompoundFieldWrite_Rejected()
    {
        const string source = @"
package p
struct S { var Value int32 }
class C {
  func F() int32 {
    let s = S{ Value: 1 }
    s.Value += 1
    return s.Value
  }
}
";
        Assert.Contains(GetDiagnostics(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetClassLocal_PostfixIncrementFieldWrite_Allowed()
    {
        const string source = @"
package p
class Box { var Value int32 = 0 }
class C {
  func F() int32 {
    let b = Box{ }
    b.Value++
    return b.Value
  }
}
";
        Assert.DoesNotContain(GetDiagnostics(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void LetStructLocal_PostfixIncrementFieldWrite_Rejected()
    {
        const string source = @"
package p
struct S { var Value int32 }
class C {
  func F() int32 {
    let s = S{ Value: 1 }
    s.Value++
    return s.Value
  }
}
";
        Assert.Contains(GetDiagnostics(source), d => d.Id == "GS0127");
    }

    [Fact]
    public void VarClassLocal_FieldWrite_Allowed_Control()
    {
        const string source = @"
package p
class Box { var Value int32 = 0 }
class C {
  func F() int32 {
    var b = Box{ }
    b.Value = 5
    return b.Value
  }
}
";
        Assert.DoesNotContain(GetDiagnostics(source), d => d.Id == "GS0127");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics.ToList();
    }
}

// <copyright file="Issue4216ReceiverAttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #4216: an annotation on an extension receiver is emitted on parameter
/// zero of the lowered static extension method.
/// </summary>
public class Issue4216ReceiverAttributeEmitTests
{
    [Fact]
    public void NotNullWhen_OnExtensionReceiver_RoundTripsThroughReflection()
    {
        const string source = """
            package Issue4216
            import System.Diagnostics.CodeAnalysis

            func (@NotNullWhen(false) value string?) IsMissing4216() bool {
                return value == nil
            }
            """;

        var assembly = CompileToAssembly(source);
        var method = assembly.GetTypes()
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
            .Single(candidate => candidate.Name == "IsMissing4216");
        var receiver = Assert.Single(method.GetParameters());
        var attribute = Assert.Single(receiver.GetCustomAttributes<NotNullWhenAttribute>());

        Assert.False(attribute.ReturnValue);
    }

    private static Assembly CompileToAssembly(string source)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(Issue4216ReceiverAttributeEmitTests), isCollectible: true);
        return loadContext.LoadFromStream(peStream);
    }
}

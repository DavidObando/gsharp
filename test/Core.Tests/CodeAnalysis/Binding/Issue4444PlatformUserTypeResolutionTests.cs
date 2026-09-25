// <copyright file="Issue4444PlatformUserTypeResolutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4444: a platform type over a G#-declared type (<c>Node!</c>, from an
/// <c>@Oblivious</c> scope) must resolve exactly as <c>Node</c> does. ADR-0186
/// §1 says <c>T!</c> has <c>T</c>'s signature, and §5a says lookup on a
/// <c>T!</c> runs against <c>T</c>.
/// <para>
/// The one root cause: overload resolution ranks imported candidates on each
/// argument's effective CLR type. That projection had an arm for every
/// G#-declared type, but none for one under a platform wrapper, so an imported
/// call that received such an argument never ranked a candidate. That gave
/// GS0159 for <c>List[Node].Add(n)</c>, for a method group whose signature is
/// <c>(Node!) -&gt; string!</c> passed to <c>Select</c>, and for an extension
/// call over such a value. The same calls over a BCL type (<c>string!</c>)
/// bound, because <c>string</c> has a CLR type.
/// </para>
/// <para>
/// Each program keeps its container element types out of the oblivious scope
/// (lists come from enabled functions or from inferred locals), so the tests
/// hold whichever way that scope reads a nested position.
/// </para>
/// </summary>
public class Issue4444PlatformUserTypeResolutionTests
{
    private const string Prelude = """
        package Probe
        import System
        import System.Linq
        import System.Collections.Generic

        class Node {
            var Name string = "n"
        }

        func NewList() List[Node] { return List[Node]() }

        func Nodes() List[Node] { return List[Node]{Node{}, Node{}} }

        """;

    /// <summary>
    /// A <c>Node!</c> argument to <c>List[Node].Add(T)</c> binds. At run time
    /// the argument is checked at the <c>T! → T</c> coercion (§4), so a nil
    /// throws <see cref="NullReferenceException"/> at the call instead of
    /// entering the list.
    /// </summary>
    [Fact]
    public void A_Platform_User_Type_Argument_Binds_To_A_Generic_Instance_Method()
    {
        const string source = """
            @Oblivious
            func AddTwo(first Node, second Node) int32 {
                let xs = NewList()
                xs.Add(first)
                xs.Add(second)
                return xs.Count
            }

            func Probe() string {
                let two = AddTwo(Node{}, Node{})
                try {
                    AddTwo(Node{}, nil)
                    return "no throw"
                } catch (e NullReferenceException) {
                    return "${two} then NRE"
                }
            }

            Console.WriteLine(Probe())
            """;

        Assert.Equal("2 then NRE\n", Run(source));
    }

    /// <summary>
    /// The same argument binds as a collection-initializer element.
    /// </summary>
    [Fact]
    public void A_Platform_User_Type_Element_Binds_In_A_Collection_Initializer()
    {
        const string source = """
            @Oblivious
            func Wrap(first Node, second Node) int32 {
                let xs = List[Node]{first, second}
                return xs.Count
            }

            Console.WriteLine(Wrap(Node{}, Node{}))
            """;

        Assert.Equal("2\n", Run(source));
    }

    /// <summary>
    /// A method group whose signature is <c>(Node!) -&gt; string!</c> infers
    /// <c>Select</c>'s type arguments, from an oblivious caller and from an
    /// enabled one.
    /// </summary>
    [Fact]
    public void A_Platform_User_Type_Method_Group_Infers_A_Generic_Call()
    {
        const string source = """
            @Oblivious
            func Render(n Node) string { return n.Name }

            @Oblivious
            func FromOblivious() string {
                return String.Join(",", Nodes().Select(Render))
            }

            func FromEnabled() string {
                return String.Join(",", Nodes().Select(Render))
            }

            Console.WriteLine(FromOblivious() + "|" + FromEnabled())
            """;

        Assert.Equal("n,n|n,n\n", Run(source));
    }

    /// <summary>
    /// An extension call over a platform user-type value binds the same
    /// extension it binds over the plain type: a <c>Node!</c> passed to a
    /// generic extension, and <c>Where</c> on a list built in the scope.
    /// </summary>
    [Fact]
    public void An_Extension_Over_A_Platform_User_Type_Binds()
    {
        const string source = """
            @Oblivious
            func CountNamed(first Node) int32 {
                let xs = NewList()
                xs.Add(first)
                return xs.Where((n Node) -> n.Name != nil).Count()
                    + Enumerable.Repeat(first, 2).Count()
            }

            Console.WriteLine(CountNamed(Node{}))
            """;

        Assert.Equal("3\n", Run(source));
    }

    private static string Run(string declarations)
    {
        var compilation = new GsCompilation(SyntaxTree.Parse(SourceText.From(Prelude + declarations)))
        {
            Nullability = NullabilityMode.PlatformTypes,
        };
        compilation.AssemblyName = "Issue4444";
        using var pe = new MemoryStream();
        var emit = compilation.Emit(pe, pdbStream: null, refStream: null, assemblyName: compilation.AssemblyName);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics.Select(d => $"{d.Id}: {d.Message}")));

        var context = new AssemblyLoadContext(nameof(Issue4444PlatformUserTypeResolutionTests) + Guid.NewGuid().ToString("N"), isCollectible: true);
        try
        {
            pe.Position = 0;
            var assembly = context.LoadFromStream(pe);
            var entry = Assert.IsAssignableFrom<MethodInfo>(assembly.EntryPoint);
            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            catch (TargetInvocationException invocation) when (invocation.InnerException != null)
            {
                throw invocation.InnerException;
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString().Replace("\r\n", "\n", StringComparison.Ordinal);
        }
        finally
        {
            context.Unload();
        }
    }
}

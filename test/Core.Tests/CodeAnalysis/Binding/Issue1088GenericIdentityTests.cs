// <copyright file="Issue1088GenericIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #1088: assigning the result of a
/// constructed-generic factory/method call to a variable or field of the SAME
/// constructed-generic type must bind when the type argument is a
/// <em>same-compilation</em> user type.
/// <para>
/// A same-compilation user type used as a CLR generic argument has a
/// <c>null</c> <c>ClrType</c> during binding and erases to <c>object</c> on the
/// closed <see cref="GSharp.Core.CodeAnalysis.Symbols.ImportedTypeSymbol"/>.
/// Comparing the erased <c>ClrType</c>s of the declared type
/// (<c>Channel[BufferEntry]</c>) against the method return type spuriously
/// reported <c>GS0155</c> with two IDENTICAL display names. The conversion
/// classifier now compares the SYMBOLIC type arguments structurally, so genuine
/// identity binds while distinct user-type arguments still fail.
/// </para>
/// </summary>
public class Issue1088GenericIdentityTests
{
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Console).Assembly.Location,
            typeof(System.Threading.Channels.Channel).Assembly.Location,
            typeof(System.Threading.Channels.BoundedChannelOptions).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            MetadataLoadContextResolver());
        var program = Binder.BindProgram(globalScope, MetadataLoadContextResolver());
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }

    [Fact]
    public void Constructed_Generic_With_UserType_Arg_Binds_In_Method_Body()
    {
        // The exact repro from issue #1088.
        var source = """
            package p
            import System.Threading.Channels

            class BufferEntry {
            }

            class C {
                func M() {
                    let ch Channel[BufferEntry] = Channel.CreateBounded[BufferEntry](BoundedChannelOptions(2))
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Constructed_Generic_With_UserType_Arg_Binds_In_Field_Initializer()
    {
        var source = """
            package p
            import System.Threading.Channels

            class BufferEntry {
            }

            class C {
                private let ch Channel[BufferEntry] = Channel.CreateBounded[BufferEntry](BoundedChannelOptions(2))
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Constructed_Generic_With_BclType_Arg_Still_Binds_In_Field_Initializer()
    {
        // Control: the all-BCL type argument case worked before the fix and
        // must keep working.
        var source = """
            package p
            import System.Threading.Channels

            class C {
                private let ch Channel[int32] = Channel.CreateBounded[int32](BoundedChannelOptions(2))
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Constructed_Generic_With_BclType_Arg_Still_Binds_In_Method_Body()
    {
        var source = """
            package p
            import System.Threading.Channels

            class C {
                func M() {
                    let ch Channel[int32] = Channel.CreateBounded[int32](BoundedChannelOptions(2))
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Same_Compilation_User_Generic_Identity_Binds()
    {
        // The fallback repro: a same-compilation user generic with a
        // same-compilation user-type argument round-trips through a factory.
        var source = """
            package p

            class Box[T] {
            }

            class BufferEntry {
            }

            class C {
                func mk() Box[BufferEntry] {
                    return Box[BufferEntry]()
                }

                func use() {
                    let b Box[BufferEntry] = mk()
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Distinct_User_Type_Arguments_Still_Report_GS0155()
    {
        // Negative: distinct user-type arguments must NOT be treated as
        // identical, so the spurious-conversion guard does not over-match.
        var source = """
            package p

            class Box[T] {
            }

            class A {
            }

            class B {
            }

            class C {
                func mk() Box[A] {
                    return Box[A]()
                }

                func use() {
                    let b Box[B] = mk()
                }
            }
            """;

        Assert.Contains(Bind(source), d => d.Id == "GS0155");
    }

    [Fact]
    public void Mismatched_Bcl_And_User_Type_Arguments_Still_Report_GS0155()
    {
        // Negative: a BCL-arg construction is not assignable to a user-type-arg
        // declaration of the same open generic.
        var source = """
            package p
            import System.Threading.Channels

            class BufferEntry {
            }

            class C {
                func M() {
                    let ch Channel[BufferEntry] = Channel.CreateBounded[int32](BoundedChannelOptions(2))
                }
            }
            """;

        Assert.Contains(Bind(source), d => d.Id == "GS0155");
    }
}

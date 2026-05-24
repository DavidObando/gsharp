// <copyright file="InlineStructTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 7.4 — inline value classes / <c>inline struct</c>.
/// </summary>
public sealed class InlineStructTests
{
    [Fact]
    public void InlineStruct_SinglePrimaryConstructorField_BindsAndCompares()
    {
        var result = Evaluate(@"
type UserId inline struct(value string)
let a = UserId(""u-1"")
let b = UserId(""u-1"")
a == b
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void InlineStruct_ToString_IncludesSingleField()
    {
        var result = Evaluate(@"
type UserId inline struct(value string) {}
let a = UserId(""u-1"")
a
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("UserId(value=u-1)", result.Value!.ToString());
    }

    [Theory]
    [InlineData("type Bad inline struct(a string, b string) {}")]
    [InlineData("type Bad inline struct {}")]
    [InlineData("type Bad inline struct(a string) { b string }")]
    [InlineData("type Bad data inline struct(value string) {}")]
    [InlineData("type Bad inline data struct(value string) {}")]
    [InlineData("type Bad open inline struct(value string) {}")]
    [InlineData("type Bad inline open struct(value string) {}")]
    public void InlineStruct_InvalidShapes_Diagnose(string declaration)
    {
        var result = Evaluate(declaration + "\n0\n");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void InlineStruct_HandWrittenSynthesizedMember_Diagnoses()
    {
        var result = Evaluate(@"
type UserId inline struct(value string) {}
func (u UserId) Equals(other UserId) bool { return true }
0
");
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void InlineStruct_DistinctUnderlyingTypes_AreNotAssignableOrComparable()
    {
        var assign = Evaluate(@"
type UserId inline struct(value string) {}
type OrderId inline struct(value string) {}
let user = UserId(""u-1"")
let order OrderId = user
0
");
        Assert.NotEmpty(assign.Diagnostics);

        var compare = Evaluate(@"
type UserId inline struct(value string) {}
type OrderId inline struct(value string) {}
UserId(""1"") == OrderId(""1"")
");
        Assert.NotEmpty(compare.Diagnostics);
    }

    [Fact]
    public void InlineStruct_PassesByValue()
    {
        var result = Evaluate(@"
type UserId inline struct(value string) {}
func echo(id UserId) UserId { return id }
let original = UserId(""u-1"")
let copied = echo(original)
original == copied
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void InlineStruct_EmitsReadOnlyMetadataAndMembers()
    {
        const string Source = @"package InlineMetadata
type UserId inline struct(value string) {}
let id = UserId(""u-1"")
";
        using var peStream = new MemoryStream();
        var emit = Compile(Source, peStream);
        Assert.True(emit.Success, string.Join("; ", emit.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        var reader = peReader.GetMetadataReader();
        var userId = reader.TypeDefinitions.Select(reader.GetTypeDefinition).Single(t => reader.GetString(t.Name) == "UserId");
        Assert.True(HasAttribute(reader, userId, "IsReadOnlyAttribute"));

        var methodNames = userId.GetMethods().Select(h => reader.GetString(reader.GetMethodDefinition(h).Name)).ToArray();
        Assert.Contains("Equals", methodNames);
        Assert.Contains("GetHashCode", methodNames);
        Assert.Contains("ToString", methodNames);
        Assert.Contains("op_Equality", methodNames);
        Assert.Contains("op_Inequality", methodNames);
        Assert.Contains("Deconstruct", methodNames);
    }

    private static bool HasAttribute(MetadataReader reader, TypeDefinition type, string name)
    {
        foreach (var handle in type.GetCustomAttributes())
        {
            var attribute = reader.GetCustomAttribute(handle);
            if (attribute.Constructor.Kind != HandleKind.MemberReference)
            {
                continue;
            }

            var member = reader.GetMemberReference((MemberReferenceHandle)attribute.Constructor);
            if (member.Parent.Kind == HandleKind.TypeReference && reader.GetString(reader.GetTypeReference((TypeReferenceHandle)member.Parent).Name) == name)
            {
                return true;
            }
        }

        return false;
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static EmitResult Compile(string source, Stream peStream)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream);
    }
}

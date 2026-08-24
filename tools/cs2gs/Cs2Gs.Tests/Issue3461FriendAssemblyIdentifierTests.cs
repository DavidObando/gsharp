// <copyright file="Issue3461FriendAssemblyIdentifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharpReferenceResolver = GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver;
using GSharpSourceText = GSharp.Core.CodeAnalysis.Text.SourceText;
using GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace Cs2Gs.Tests;

/// <summary>Issue #3461: friend-visible inherited members reserve emitted names.</summary>
public sealed class Issue3461FriendAssemblyIdentifierTests
{
    [Fact]
    public void FriendInternalInheritedName_ReservesDerivedAllocationAtRuntime()
    {
        string directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3461FriendAssemblyIdentifierTests));
        Directory.CreateDirectory(directory);
        string libraryPath = Path.Combine(directory, "Friend.Library.dll");
        CSharpCompilation library = CSharpCompilation.Create(
            "Friend.Library",
            new[]
            {
                CSharpSyntaxTree.ParseText(
                    """
                    using System.Runtime.CompilerServices;

                    [assembly: InternalsVisibleTo("Friend.Consumer")]

                    namespace FriendLib;

                    public class Base
                    {
                        internal int defer_() => 100;
                    }
                    """),
            },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using (FileStream stream = File.Create(libraryPath))
        {
            var emit = library.Emit(stream);
            Assert.True(
                emit.Success,
                string.Join(Environment.NewLine, emit.Diagnostics));
        }

        var references = CSharpProjectLoader.RuntimeReferences()
            .Append(MetadataReference.CreateFromFile(libraryPath))
            .ToArray();
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[]
            {
                ("Consumer.cs", """
                    using FriendLib;

                    public sealed class Derived : Base
                    {
                        public int @defer() => 7;

                        public int Run() => @defer();
                    }

                    public static class Holder
                    {
                        public static int Run() => new Derived().Run();
                    }
                    """),
            },
            references,
            assemblyName: "Friend.Consumer");
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.Contains("func defer__()", rendered, StringComparison.Ordinal);
        Assert.Contains("func Run() int32 -> defer__()", rendered, StringComparison.Ordinal);

        using var resolver = GSharpReferenceResolver.WithReferences(
            new[] { libraryPath });
        resolver.CurrentAssemblyName = "Friend.Consumer";
        TranslationTestValidation.AssertBinds(resolver, rendered);
        var compilation = new GSharpCompilation(
            resolver,
            GSharpSyntaxTree.Parse(GSharpSourceText.From(rendered)))
        {
            IsLibrary = true,
        };
        using var image = new MemoryStream();
        var result = compilation.Emit(
            image,
            pdbStream: null,
            refStream: null,
            assemblyName: "Friend.Consumer");
        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics));
        image.Position = 0;

        var loadContext = new AssemblyLoadContext(
            nameof(FriendInternalInheritedName_ReservesDerivedAllocationAtRuntime),
            isCollectible: true);
        try
        {
            loadContext.Resolving += (_, name) =>
                name.Name == "Friend.Library"
                    ? loadContext.LoadFromAssemblyPath(libraryPath)
                    : null;
            Assembly assembly = loadContext.LoadFromStream(image);
            Type holder = assembly.GetTypes().Single(defer => defer.Name == "Holder");
            MethodInfo run = holder.GetMethod(
                "Run",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(run);
            Assert.Equal(7, run.Invoke(null, null));
        }
        finally
        {
            loadContext.Unload();
        }
    }
}

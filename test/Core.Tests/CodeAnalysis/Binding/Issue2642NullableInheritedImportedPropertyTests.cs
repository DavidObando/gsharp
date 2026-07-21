// <copyright file="Issue2642NullableInheritedImportedPropertyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2642NullableInheritedImportedPropertyTests
{
    private const string LibrarySource = """
        package Issue2642.Ref

        open class UserSettingsBase {
            prop DownloadSettings string {
                get -> "2642"
            }
        }
        """;

    [Fact]
    public void OahuSettings_NullConditionalFindsImportedBaseProperty()
    {
        var result = CompileConsumer("""
            package Issue2642.App
            import Issue2642.Ref

            class OahuUserSettings : UserSettingsBase { }

            class CoreEnvironment {
                shared {
                    var settings OahuUserSettings?
                    func Read() string? -> CoreEnvironment.settings?.DownloadSettings
                }
            }
            """, nameof(this.OahuSettings_NullConditionalFindsImportedBaseProperty));

        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void UnknownPropertyThroughNullConditional_StillReportsGS0158()
    {
        var result = CompileConsumer("""
            package Issue2642.App
            import Issue2642.Ref

            class OahuUserSettings : UserSettingsBase { }

            class CoreEnvironment {
                shared {
                    var settings OahuUserSettings?
                    func Read() string? -> CoreEnvironment.settings?.NotDownloadSettings
                }
            }
            """, nameof(this.UnknownPropertyThroughNullConditional_StillReportsGS0158));

        Assert.Single(result.Diagnostics, diagnostic => diagnostic.Id == "GS0158");
    }

    private static EmitResult CompileConsumer(string source, string caseName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2642", caseName);
        Directory.CreateDirectory(directory);
        var libraryPath = Path.Combine(directory, "Issue2642.Ref.dll");

        var library = new Compilation(SyntaxTree.Parse(SourceText.From(LibrarySource)))
        {
            IsLibrary = true,
        };
        using (var stream = File.Create(libraryPath))
        {
            var result = library.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Issue2642.Ref");
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        using var references = ReferenceResolver.WithReferences(new[] { libraryPath });
        references.CurrentAssemblyName = "Issue2642.App";
        var consumer = new Compilation(
            references,
            SyntaxTree.Parse(SourceText.From(source)))
        {
            IsLibrary = true,
        };
        using var output = new MemoryStream();
        return consumer.Emit(output, pdbStream: null, refStream: null, assemblyName: "Issue2642.App");
    }
}

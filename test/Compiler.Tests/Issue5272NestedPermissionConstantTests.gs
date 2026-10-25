// <copyright file="Issue5272NestedPermissionConstantTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #5272: imported nested string literals remain constants in attributes.
class Issue5272NestedPermissionConstantTests {
    @Fact
    func CompilerDriverEmitsNestedLiteralValuesInAttributeMetadata() {
        using let fixture = CSharpFixture(ContractSource)
        const source = `package App
import PermissionContracts
import C = PermissionContracts
import M = PermissionContracts.Manifest

@Provider([]string{"org.example.permission.probe"}, Permission: PermissionContracts.Manifest.Permission.ManageDocuments, Code = Manifest.Permission.Code)
class Qualified {}
@Provider([]string{C.Manifest.Permission.Empty}, Permission = M.Permission.ManageDocuments)
class Aliased {}
@Provider([]string{Manifest.Permission.Deep.Token}, Permission = Manifest.Top)
class Deep {}
@Provider([]string{Manifest.Permission.Null}, Permission = Manifest.Permission.Null)
class NullValue {}`
        let image = Compile(fixture, source)
        let assemblies = fixture.LoadTogether(File.ReadAllBytes(fixture.AssemblyPath), image)
        let attributeType = assemblies[0].GetType("PermissionContracts.ProviderAttribute")!!
        let expected = []string{
            "Qualified|org.example.permission.probe|android.permission.MANAGE_DOCUMENTS|23",
            "Aliased||android.permission.MANAGE_DOCUMENTS|0",
            "Deep|deep-token|top-level|0",
            "NullValue|<null>|<null>|0"
        }
        let actual = List[string]()
        for name in[]string{"Qualified", "Aliased", "Deep", "NullValue"} {
            let target = assemblies[1].GetType("App." + name)!!
            let data = Assert.Single(
                target.GetCustomAttributesData(),
                (a CustomAttributeData) -> a.AttributeType == attributeType
            )
            let authorities = Assert.IsAssignableFrom[IList[CustomAttributeTypedArgument]](
                Assert.Single(data.ConstructorArguments).Value
            )
            let authority = Assert.Single(authorities).Value as string
            let permission = Assert
                .Single(data.NamedArguments, (a CustomAttributeNamedArgument) -> a.MemberName == "Permission")
                .TypedValue
                .Value as string
            let codeArguments = data
                .NamedArguments
                .Where((a CustomAttributeNamedArgument) -> a.MemberName == "Code")
                .ToArray()
            let code = if codeArguments.Length == 0 {
                0
            } else {
                Assert.IsType[int32](Assert.Single(codeArguments).TypedValue.Value)
            }
            actual.Add(name + "|" + (authority ?? "<null>") + "|" + (permission ?? "<null>") + "|" + code.ToString())
            let instance = Assert.Single(target.GetCustomAttributes(attributeType, inherit: false))
            Assert.Equal(permission, attributeType.GetProperty("Permission")!!.GetValue(instance))
            Assert.Equal(
                authority,
                Assert.Single(Assert.IsType[[]string](attributeType.GetProperty("Authorities")!!.GetValue(instance)))
            )
        }
        Assert.Equal[string](expected, actual)
    }

    @Fact
    func NonliteralMembersAndInvalidAttributeValuesKeepTheirDiagnosticLocations() {
        using let fixture = CSharpFixture(ContractSource)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
        for expression in[]string{
            "Manifest.Permission.Readonly",
            "Manifest.Permission.Variable",
            "Manifest.Permission.Property",
            "Collision.Permission.ManageDocuments",
            "[]decimal{1m}"
        } {
            let source = "import PermissionContracts\n@Provider([]string{}, Permission: " +
                expression +
                ")\nclass Rejected {}"
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            let diagnostics = compilation.GetDiagnostics()
            Assert.True(
                diagnostics.Any((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0202"),
                expression + ": " + string.Join(Environment.NewLine, diagnostics)
            )
            let diagnostic = Assert.Single(diagnostics)
            Assert.Equal("GS0202", diagnostic.Id)
            Assert.Equal(source.IndexOf(expression, StringComparison.Ordinal), diagnostic.Location.Span.Start)
            Assert.Equal(expression.Length, diagnostic.Location.Span.Length)
        }
    }

    shared {
        private func Compile(fixture CSharpFixture, source string)[]uint8 {
            let sourcePath = Path.Combine(fixture.DirectoryPath, "PermissionCarrier.gs")
            let outputPath = Path.Combine(fixture.DirectoryPath, "Subject.dll")
            File.WriteAllText(sourcePath, source)
            let start = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "gsc.dll"))
            start.ArgumentList.Add("/target:library")
            start.ArgumentList.Add("/targetframework:net10.0")
            start.ArgumentList.Add("/out:" + outputPath)
            start.ArgumentList.Add("/reference:" + fixture.AssemblyPath)
            for reference in ReferenceResolver.HostTrustedPlatformAssemblyPaths() {
                start.ArgumentList.Add("/reference:" + reference)
            }
            start.ArgumentList.Add(sourcePath)
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start gsc.")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(60_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                Assert.Fail("gsc did not finish within 60 seconds.")
            }
            Assert.True(process.ExitCode == 0, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult())
            return File.ReadAllBytes(outputPath)
        }

        private const ContractSource string = `using System;
namespace PermissionContracts
{
    public class Manifest
    {
        public const string Top = "top-level";
        public class Permission
        {
            public const string ManageDocuments = "android.permission.MANAGE_DOCUMENTS";
            public const string Empty = "";
            public const string Null = null;
            public const int Code = 23;
            public static readonly string Readonly = "not-a-constant";
            public static string Variable = "not-a-constant";
            public static string Property => "not-a-constant";
            public class Deep { public const string Token = "deep-token"; }
        }
    }
    public class Values { public string ManageDocuments = "not-a-constant"; }
    public class Collision : Manifest
    {
        public new static readonly Values Permission = new Values();
    }
    [AttributeUsage(AttributeTargets.Class)]
    public sealed class ProviderAttribute : Attribute
    {
        public ProviderAttribute(string[] authorities) => Authorities = authorities;
        public string[] Authorities { get; }
        public string Permission { get; set; }
        public int Code { get; set; }
    }
}`
    }
}

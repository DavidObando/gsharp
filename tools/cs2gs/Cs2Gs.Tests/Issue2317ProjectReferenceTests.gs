// <copyright file="Issue2317ProjectReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Xml.Linq
import Cs2Gs.Pipeline
import Xunit

/// Regression tests for issue #2317 dependency and solution fidelity.
open class Issue2317ProjectReferenceTests {
    @Fact
    func PipelineOptions_UsesSdkCompilationByDefault() {
        Assert.True(PipelineOptions().CompileViaSdk)
    }

    @Fact
    func RewriteProjectReferences_UsesGeneratedProjectForMigratedTarget() {
        using let directory = Issue2317ProjectReferenceTests.ScratchDirectory()
        let sourceApp = Path.Combine(directory.Path, "src", "App")
        let sourceLib = Path.Combine(directory.Path, "src", "Lib")
        let targetApp = Path.Combine(directory.Path, "out", "App")
        let targetLib = Path.Combine(directory.Path, "out", "Lib", "Lib.gsproj")
        Directory.CreateDirectory(sourceApp)
        Directory.CreateDirectory(sourceLib)
        Directory.CreateDirectory(targetApp)
        let projectPath = Path.Combine(sourceApp, "App.csproj")
        File.WriteAllText(
            projectPath,
            "<Project><ItemGroup Condition=\"'$$(Configuration)' == 'Release'\">" +
                "<ProjectReference Include=\"../Lib/Lib.csproj\" Aliases=\"lib\" />" +
                "</ItemGroup></Project>"
        )
        let items = DeclaredProjectItems.Read(projectPath, "ProjectReference")
        let rewritten = DeclaredProjectItems.RewriteProjectReferences(
            items,
            targetApp,
            Dictionary[string, string](StringComparer.OrdinalIgnoreCase){
                [Path.Combine(sourceLib, "Lib.csproj")] = targetLib
            }
        )
        let item = Assert.Single(rewritten)
        Assert.Equal("'$$(Configuration)' == 'Release'", item.ItemGroupCondition)
        Assert.Equal(Path.GetRelativePath(targetApp, targetLib), item.Element.Attribute(XName?("Include")!!)?.Value)
        Assert.Equal("lib", item.Element.Attribute(XName?("Aliases")!!)?.Value)
    }

    @Fact
    func RewriteProjectReferences_OmitsUnresolvedItemExpression() {
        using let directory = Issue2317ProjectReferenceTests.ScratchDirectory()
        let sourceApp = Path.Combine(directory.Path, "src", "App")
        let targetApp = Path.Combine(directory.Path, "out", "App")
        Directory.CreateDirectory(sourceApp)
        Directory.CreateDirectory(targetApp)
        let projectPath = Path.Combine(sourceApp, "App.csproj")
        File.WriteAllText(
            projectPath,
            "<Project><ItemGroup><ProjectReference Include=\"@(SharedProjects)\" /></ItemGroup></Project>"
        )
        let items = DeclaredProjectItems.Read(projectPath, "ProjectReference")
        let rewritten = DeclaredProjectItems.RewriteProjectReferences(
            items,
            targetApp,
            Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
        )
        Assert.Empty(rewritten)
    }

    @Fact
    func RewriteProjectReferences_NullInputsKeepTheirDeclaredContract() {
        let method MethodInfo? = typeof(DeclaredProjectItems).GetMethod(
            "RewriteProjectReferences",
            BindingFlags.Static | BindingFlags.NonPublic
        )
        Assert.NotNull(method)
        let nullability = NullabilityInfoContext()
        Assert.Equal(NullabilityState.Nullable, nullability.Create(method!!.GetParameters()[0]).ReadState)
        Assert.Equal(NullabilityState.Nullable, nullability.Create(method!!.GetParameters()[2]).ReadState)
        Assert.Empty(DeclaredProjectItems.RewriteProjectReferences(nil, AppContext.BaseDirectory, nil))
        let item = DeclaredProjectItem(
            nil,
            XElement(XName?("ProjectReference")!!, XAttribute(XName?("Include")!!, "Lib.csproj"))
        )
        let rewritten = Assert.Single(
            DeclaredProjectItems.RewriteProjectReferences([]DeclaredProjectItem{item}, AppContext.BaseDirectory, nil)
        )
        Assert.Equal("Lib.csproj", rewritten.Element.Attribute(XName?("Include")!!)?.Value)
        Assert.NotSame(item.Element, rewritten.Element)
    }

    @Fact
    func DeclaredPackageReference_IdentifiesUnresolvedItemExpression() {
        using let directory = Issue2317ProjectReferenceTests.ScratchDirectory()
        let projectPath = Path.Combine(directory.Path, "App.csproj")
        File.WriteAllText(
            projectPath,
            "<Project><ItemGroup><PackageReference Include=\"@(SharedPackages)\" /></ItemGroup></Project>"
        )
        let item = Assert.Single(DeclaredProjectItems.Read(projectPath, "PackageReference"))
        Assert.True(DeclaredProjectItems.HasMsbuildExpressionInclude(item))
    }

    @Fact
    func GenerateSolutions_WritesSlnxAndRewritesOnlyMigratedProjects() {
        using let directory = Issue2317ProjectReferenceTests.ScratchDirectory()
        let source = Path.Combine(directory.Path, "source")
        let target = Path.Combine(directory.Path, "target")
        let app = Path.Combine(source, "App", "App.csproj")
        let library = Path.Combine(source, "Lib", "Lib.csproj")
        let generatedApp = Path.Combine(target, "corpus_App", "App.gsproj")
        Directory.CreateDirectory(Path.GetDirectoryName(app)!!)
        Directory.CreateDirectory(Path.GetDirectoryName(library)!!)
        File.WriteAllText(app, "<Project />")
        File.WriteAllText(library, "<Project />")
        Directory.CreateDirectory(source)
        File.WriteAllText(
            Path.Combine(source, "Sample.sln"),
            "Microsoft Visual Studio Solution File, Format Version 12.00\n" +
                "Project(\"{66A26720-8FB5-11D2-AA7E-00C04F688DDE}\") = \"src\", \"src\", \"{0}\"\n" +
                "EndProject\n" +
                "Project(\"{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}\") = \"App\", \"App\\App.csproj\", \"{1}\"\n" +
                "EndProject\n" +
                "Project(\"{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}\") = \"Lib\", \"Lib\\Lib.csproj\", \"{2}\"\n" +
                "EndProject\n"
        )
        let solutions = SolutionGenerator.Generate(
            source,
            target,
            Dictionary[string, string](StringComparer.OrdinalIgnoreCase){[app] = generatedApp}
        )
        let solution = Assert.Single(solutions)
        Assert.Equal(".slnx", Path.GetExtension(solution))
        let projects = SolutionGenerator.ReadProjects(solution)
        Assert.Contains(generatedApp, projects, StringComparer.OrdinalIgnoreCase)
        Assert.Contains(library, projects, StringComparer.OrdinalIgnoreCase)
    }

    private class ScratchDirectory : IDisposable {
        init() {
            this.Path = Path.Combine(Path.GetTempPath(), "cs2gs-issue2317-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(this.Path)
        }

        prop Path string {
            get;
        }

        func Dispose() {
            Directory.Delete(this.Path, recursive: true)
        }
    }
}

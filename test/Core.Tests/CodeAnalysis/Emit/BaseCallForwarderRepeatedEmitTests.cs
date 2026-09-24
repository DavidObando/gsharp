// <copyright file="BaseCallForwarderRepeatedEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// The base-call forwarder pass attaches its <c>&lt;&gt;n__N</c> methods to
/// the bound class symbol, which the compilation caches. A second
/// <c>Compilation.Emit</c> ran the pass again over the same class: it added a
/// second set of forwarders while the first set, still in the class's method
/// list, had no body in the new program. Repeated emit must produce the same
/// assembly, each with one forwarder per shape, that runs.
/// </summary>
public sealed class BaseCallForwarderRepeatedEmitTests
{
    private const string Source = """
        package ForwarderEmit
        import System
        import System.Threading.Tasks

        open class Base {
            open func Name() string { return "base" }
        }

        public class Derived : Base {
            override func Name() string { return "derived" }

            public func Go() string {
                let call = () -> base.Name()
                let group = func () string {
                    let h () -> string = base.Name
                    return h()
                }
                return call() + " " + group()
            }

            public async func GoAsync() Task[string] {
                await Task.Yield()
                return base.Name()
            }
        }
        """;

    [Fact]
    public async Task RepeatedEmit_ProducesOneForwarderSetAndRunnableAssemblies()
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(Source, "forwarders.gs"))) { IsLibrary = true };
        using var first = new MemoryStream();
        using var second = new MemoryStream();
        var firstResult = compilation.Emit(first);
        var secondResult = compilation.Emit(second);
        Assert.True(firstResult.Success, string.Join("; ", firstResult.Diagnostics.Select(d => d.Message)));
        Assert.True(secondResult.Success, string.Join("; ", secondResult.Diagnostics.Select(d => d.Message)));
        Assert.Equal(first.ToArray(), second.ToArray());

        foreach (var image in new[] { first, second })
        {
            image.Position = 0;
            var context = new AssemblyLoadContext(nameof(RepeatedEmit_ProducesOneForwarderSetAndRunnableAssemblies), isCollectible: true);
            try
            {
                var assembly = context.LoadFromStream(image);
                var derived = assembly.GetTypes().Single(type => type.Name == "Derived");
                var forwarders = derived
                    .GetMethods(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)
                    .Where(method => method.Name.StartsWith("<>n__", StringComparison.Ordinal))
                    .Select(method => method.Name)
                    .ToArray();
                Assert.Equal(forwarders.Distinct(StringComparer.Ordinal).Count(), forwarders.Length);
                Assert.Single(forwarders);

                var instance = Activator.CreateInstance(derived);
                Assert.Equal("base base", derived.GetMethod("Go")!.Invoke(instance, null));
                var task = (Task<string>)derived.GetMethod("GoAsync")!.Invoke(instance, null)!;
                Assert.Equal("base", await task);
            }
            finally
            {
                context.Unload();
            }
        }
    }
}

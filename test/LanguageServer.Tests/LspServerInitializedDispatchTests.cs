// <copyright file="LspServerInitializedDispatchTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading.Tasks;
using GSharp.LanguageServer.Protocol;
using GSharp.LanguageServer.Server;
using Nerdbank.Streams;
using StreamJsonRpc;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// The LSP "initialized" notification carries a params object ({}). StreamJsonRpc only routes
/// that object to <see cref="LspServer.Initialized"/>'s single <c>JsonElement</c> parameter when
/// the handler opts into single-object parameter deserialization (as every other params-taking
/// handler does); without it the notification is silently dropped, so background workspace
/// discovery never runs, no project is ever registered, and every file binds against a
/// project-less compilation (all imported symbols show spurious "could not be found" squiggles).
///
/// The other tests in this suite invoke <see cref="LspServer.Initialized"/> directly, which
/// bypasses JSON-RPC dispatch and cannot catch a wiring regression. This test drives the server
/// over a real StreamJsonRpc connection — exactly as <c>Program.RunAsync</c> hosts it — so the
/// "initialized" notification must actually dispatch for the assertion to hold.
/// </summary>
public class LspServerInitializedDispatchTests
{
    [Fact]
    public async Task InitializedNotification_OverRpc_TriggersBackgroundDiscovery()
    {
        var rootDir = CreateSampleWorkspace();
        try
        {
            var workspace = new WorkspaceState();
            var server = new LspServer(new DocumentContentService(), workspace);

            var (clientStream, serverStream) = FullDuplexStream.CreatePair();

            using var serverRpc = new JsonRpc(new HeaderDelimitedMessageHandler(
                serverStream,
                serverStream,
                new SystemTextJsonFormatter { JsonSerializerOptions = LspJson.Options }));
            serverRpc.AddLocalRpcTarget(server, new JsonRpcTargetOptions { DisposeOnDisconnect = false });
            server.Attach(serverRpc);
            serverRpc.StartListening();

            using var clientRpc = new JsonRpc(new HeaderDelimitedMessageHandler(
                clientStream,
                clientStream,
                new SystemTextJsonFormatter { JsonSerializerOptions = LspJson.Options }));
            clientRpc.StartListening();

            // Full handshake exactly as a real client performs it: an "initialize" request whose
            // params carry rootPath, followed by an "initialized" notification with an empty
            // params object.
            await clientRpc.InvokeWithParameterObjectAsync<InitializeResult>(
                "initialize",
                new { rootPath = rootDir });

            await clientRpc.NotifyWithParameterObjectAsync("initialized", new { });

            // If "initialized" dispatched, background discovery registers the workspace's project.
            await WaitForAsync(() => workspace.Projects.Count > 0);

            var project = Assert.Single(workspace.Projects);
            Assert.Equal("Demo", project.AssemblyName);
        }
        finally
        {
            Directory.Delete(rootDir, recursive: true);
        }
    }

    private static string CreateSampleWorkspace()
    {
        var rootDir = Path.Combine(Path.GetTempPath(), "gsdispatch_" + Guid.NewGuid().ToString("N"));
        var projDir = Path.Combine(rootDir, "Demo");
        Directory.CreateDirectory(projDir);

        File.WriteAllText(
            Path.Combine(projDir, "Demo.gsproj"),
            "<Project Sdk=\"Gsharp.NET.Sdk\">\n  <PropertyGroup><OutputType>Library</OutputType><TargetFramework>net10.0</TargetFramework><AssemblyName>Demo</AssemblyName></PropertyGroup>\n</Project>\n");

        File.WriteAllText(Path.Combine(projDir, "Foo.gs"), "class Foo {\n  func run() int -> 1\n}\n");

        return rootDir;
    }

    private static async Task WaitForAsync(Func<bool> condition, int timeoutMs = 10000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
            {
                Assert.Fail("Timed out waiting for background discovery — the 'initialized' notification likely did not dispatch.");
            }

            await Task.Delay(25);
        }
    }
}

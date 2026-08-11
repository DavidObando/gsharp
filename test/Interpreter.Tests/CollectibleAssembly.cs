// <copyright file="CollectibleAssembly.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using System.Runtime.Loader;

namespace GSharp.Interpreter.Tests;

internal static class CollectibleAssembly
{
    public static void Inspect(string assemblyPath, Action<Assembly> inspect)
        => Inspect(
            assemblyPath,
            assembly =>
            {
                inspect(assembly);
                return true;
            });

    public static T Inspect<T>(string assemblyPath, Func<Assembly, T> inspect)
    {
        var directory = Path.GetDirectoryName(assemblyPath)!;
        var loadContext = new AssemblyLoadContext(
            "gsharp-test-inspection-" + Guid.NewGuid().ToString("N"),
            isCollectible: true);
        loadContext.Resolving += (context, name) =>
        {
            var localPath = Path.Combine(directory, name.Name + ".dll");
            if (File.Exists(localPath))
            {
                using var dependency = File.OpenRead(localPath);
                return context.LoadFromStream(dependency);
            }

            try
            {
                return Assembly.Load(name);
            }
            catch (Exception ex) when (ex is FileNotFoundException or FileLoadException or BadImageFormatException)
            {
                return null;
            }
        };

        try
        {
            using var stream = File.OpenRead(assemblyPath);
            return inspect(loadContext.LoadFromStream(stream));
        }
        finally
        {
            loadContext.Unload();
        }
    }
}

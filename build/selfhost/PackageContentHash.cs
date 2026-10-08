using NuGet.Packaging;

if (args.Length != 1)
{
    return 2;
}

using var reader = new PackageArchiveReader(args[0]);
Console.Write(reader.GetContentHash(CancellationToken.None));
return 0;

namespace Issue2546;

internal sealed class Consumer
{
    public List<string> Items = new List<string>();

    public HttpClient Client = new HttpClient();

    public CancellationToken Token = default;

    public object Complete(string path)
    {
        Console.WriteLine(path);
        return Task.FromResult(Regex.Replace(Path.GetFileName(path), @"\s", string.Empty));
    }
}

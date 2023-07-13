import * as fs from "javy/fs";

export type ShopifyFunction<Input extends {}, Output extends {}> = (
  input: Input
) => Output;

export default function <I extends {}, O extends {}>(userfunction: ShopifyFunction<I, O>) {
  const input_data = fs.readFileSync(fs.STDIO.Stdin);
  const input_str = new TextDecoder("utf-8").decode(input_data);
  const input_obj = JSON.parse(input_str);
  const output_obj = userfunction(input_obj);
  const output_str = JSON.stringify(output_obj);
  const output_data = new TextEncoder().encode(output_str);
  fs.writeFileSync(fs.STDIO.Stdout, output_data);
}

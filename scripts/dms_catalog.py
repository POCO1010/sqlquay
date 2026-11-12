"""Read only DMS instance/database metadata; never expose hosts or account fields."""
import re
from engine_policy import engine_type, ENVIRONMENTS

ID = re.compile(r"[1-9][0-9]{0,19}")
FIELDS = "{InstanceId:InstanceId,InstanceAlias:InstanceAlias,InstanceType:InstanceType,EnvType:EnvType,State:State}"

def instance_row(row):
    if not isinstance(row, dict): return None
    identity, name = str(row.get("InstanceId", "")), row.get("InstanceAlias")
    engine, environment = engine_type(row.get("InstanceType")), str(row.get("EnvType", "")).lower()
    if not ID.fullmatch(identity) or engine is None or environment not in ENVIRONMENTS or row.get("State") != "NORMAL":
        return None
    if not isinstance(name, str) or not name or len(name) > 256 or re.search(r"[\x00-\x1f]", name):
        name = "#" + identity
    return dict(instanceId=identity, instanceName=name, engine=engine, environment=environment)

def catalog(executor, args):
    page = ["--page-number", str(args.page), "--page-size", "100"]
    if args.operation == "instances":
        options = page + ["--instance-state", "NORMAL"]
        if args.keyword: options += ["--search-key", args.keyword]
        if args.environment: options += ["--env-type", args.environment]
        data = executor.command_json("list-instances", options + ["--cli-query",
            "{Success:Success,TotalCount:TotalCount,InstanceList:{Instance:InstanceList.Instance[]." + FIELDS + "}}"])
        if data.get("Success") is not True: raise ValueError("Instance listing failed")
        rows = [instance_row(row) for row in data.get("InstanceList", {}).get("Instance", [])]
        result = [row for row in rows if row and (not args.engine or row["engine"] == args.engine) and (not args.environment or row["environment"] == args.environment)]
        return dict(instances=result, more=int(data.get("TotalCount", 0)) > args.page * 100, page=args.page)
    # The extension supplies identity from its verified instance list, not from form values.
    if not args.instance_name or len(args.instance_name) > 256 or re.search(r"[\x00-\x1f]", args.instance_name) or not args.engine or args.environment not in ENVIRONMENTS:
        raise ValueError("Load the instance list first")
    instance = dict(instanceId=args.instance_id,instanceName=args.instance_name,engine=args.engine,environment=args.environment)
    options = page + ["--instance-id", args.instance_id]
    if args.keyword: options += ["--search-key", args.keyword]
    data = executor.command_json("list-databases", options + ["--cli-query",
        "{Success:Success,TotalCount:TotalCount,DatabaseList:{Database:DatabaseList.Database[].{SchemaName:SchemaName,DatabaseId:DatabaseId,InstanceId:InstanceId,DbType:DbType,EnvType:EnvType,State:State,Logic:Logic}}}"])
    if data.get("Success") is not True: raise ValueError("Database listing failed")
    databases = []
    for row in data.get("DatabaseList", {}).get("Database", []):
        name, identity = row.get("SchemaName"), str(row.get("DatabaseId", ""))
        if not isinstance(name, str) or not name or len(name) > 128 or re.search(r"[\x00-\x1f]", name) or not ID.fullmatch(identity) or row.get("Logic") is True:
            continue
        if str(row.get("InstanceId")) != args.instance_id or engine_type(row.get("DbType")) != instance["engine"] or row.get("EnvType") != instance["environment"] or row.get("State") not in {None,"NORMAL"}:
            continue
        databases.append(dict(**instance, database=name, databaseId=identity, keyword=name,
            label=" · ".join([name, instance["instanceName"], instance["environment"], instance["engine"], "#" + identity])))
    return dict(databases=databases, instance=instance, more=int(data.get("TotalCount", 0)) > args.page * 100, page=args.page)
